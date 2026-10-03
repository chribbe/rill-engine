// Rill editor MCP server (stdio, no dependencies):
//   node tools/mcp/rill-mcp.ts          (Claude Code starts it from .mcp.json)
//
// Exposes the running editor's structured tools - scene queries, every editor
// operation, capture_view, changesets - to an MCP client. Calls go to the vite
// dev server's AI relay (tools/dev/ai_relay.ts), which forwards them to the open
// editor tab; nothing here edits files or the scene directly. Needs `npm run dev`
// and the editor open in a browser (http://localhost:5173/?map=<map>).
//
// Env: RILL_URL (default http://127.0.0.1:5173).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.RILL_URL ?? 'http://127.0.0.1:5173';
const CACHE = join(import.meta.dirname, '..', '..', 'build', 'ai', 'tools.json');
const VERSION = '0.1.0';

interface ParamSpec { type: string; description: string; optional?: boolean; enum?: string[] }
interface ToolInfo { name: string; description: string; params: Record<string, ParamSpec>; kind?: string }

const FALLBACK_INSTRUCTIONS = 'Tools for the Rill web editor (a WebGPU level editor). Start with get_ai_context. Units are metres, Y up, north = -Z. Group edits with begin_changeset / commit_changeset; look at your work with capture_view.';

function log(...a: unknown[]) {
  process.stderr.write(`[rill-mcp] ${a.map(String).join(' ')}\n`);
}

function send(msg: unknown) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

// ------------------------------------------------------------------ tool catalogue

let tools: ToolInfo[] = [];
let conventions = '';
let toolsKey = '';

function loadCache() {
  try {
    if (!existsSync(CACHE)) return;
    const c = JSON.parse(readFileSync(CACHE, 'utf8'));
    if (Array.isArray(c.tools)) { tools = c.tools; conventions = c.conventions ?? ''; toolsKey = JSON.stringify(tools.map((t) => t.name)); }
  } catch { /* ignore */ }
}

async function refreshTools(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/__ai/tools`);
    if (!r.ok) return false;
    const j = await r.json() as { tools: ToolInfo[]; conventions?: string };
    const key = JSON.stringify(j.tools.map((t) => t.name));
    tools = j.tools;
    conventions = j.conventions ?? conventions;
    const changed = key !== toolsKey;
    toolsKey = key;
    return changed;
  } catch {
    return false;
  }
}

function schema(p: ParamSpec): Record<string, unknown> {
  const d = { description: p.description };
  switch (p.type) {
    case 'string': return { type: 'string', ...(p.enum ? { enum: p.enum } : {}), ...d };
    case 'number': return { type: 'number', ...d };
    case 'boolean': return { type: 'boolean', ...d };
    case 'string[]': return { type: 'array', items: { type: 'string' }, ...d };
    case 'vec3': return { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, ...d };
    case 'quat': return { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, ...d };
    case 'object': return { type: 'object', ...d };
    default: return d;
  }
}

function toolList() {
  const list = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.params ?? {}).map(([k, p]) => [k, schema(p)])),
      required: Object.entries(t.params ?? {}).filter(([, p]) => !p.optional).map(([k]) => k),
    },
  }));
  list.push({
    name: 'editor_status', description: 'Whether a Rill editor tab is open and reachable (and which map).',
    inputSchema: { type: 'object', properties: {}, required: [] },
  });
  return list;
}

// ------------------------------------------------------------------ calls

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === 'editor_status') {
    try {
      const r = await fetch(`${BASE}/__ai/status`);
      return { content: [{ type: 'text', text: JSON.stringify(await r.json(), null, 1) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `dev server not reachable at ${BASE} (${(e as Error).message}): run npm run dev and open the editor` }], isError: true };
    }
  }
  const params = { ...args };
  // Images for the model: JPEG at a moderate size unless asked otherwise.
  if (name === 'capture_view') {
    params.format ??= 'jpeg';
    params.width ??= 1280;
    params.height ??= 720;
  }
  let out: { ok: boolean; result?: unknown; error?: string };
  try {
    const r = await fetch(`${BASE}/__ai/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, params, timeoutMs: 180000 }) });
    out = await r.json();
  } catch (e) {
    return { content: [{ type: 'text', text: `dev server not reachable at ${BASE} (${(e as Error).message}): run npm run dev and open the editor` }], isError: true };
  }
  if (!out.ok) return { content: [{ type: 'text', text: out.error ?? 'failed' }], isError: true };
  const content: Record<string, unknown>[] = [];
  let result = out.result as Record<string, unknown> | unknown;
  if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).image === 'string') {
    const url = (result as Record<string, string>).image;
    const m = url.match(/^data:(image\/[\w+]+);base64,(.*)$/);
    if (m) content.push({ type: 'image', mimeType: m[1], data: m[2] });
    const { image: _img, ...rest } = result as Record<string, unknown>;
    result = rest;
  }
  let text = result === undefined ? 'ok' : JSON.stringify(result, null, 1);
  if (text.length > 60000) text = `${text.slice(0, 60000)}\n... (truncated: narrow the query)`;
  content.push({ type: 'text', text });
  return { content };
}

// ------------------------------------------------------------------ JSON-RPC over stdio

async function handle(msg: { id?: number | string; method?: string; params?: Record<string, unknown> }) {
  const { id, method, params } = msg;
  if (method === undefined) return; // a response to something we never sent
  const reply = (result: unknown) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code: number, message: string) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message } }); };
  try {
    switch (method) {
      case 'initialize': {
        await refreshTools();
        reply({
          protocolVersion: (params?.protocolVersion as string) ?? '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'rill-editor', version: VERSION },
          instructions: conventions ? `Tools for the Rill web editor (a WebGPU level editor; the map open in the browser is the authoritative level).\n${conventions}` : FALLBACK_INSTRUCTIONS,
        });
        return;
      }
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        await refreshTools();
        reply({ tools: toolList() });
        return;
      case 'tools/call':
        reply(await callTool(String(params?.name), (params?.arguments as Record<string, unknown>) ?? {}));
        return;
      default:
        if (id !== undefined) fail(-32601, `method not found: ${method}`);
    }
  } catch (e) {
    fail(-32603, (e as Error).message);
  }
}

loadCache();
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch (e) {
      log('bad message', (e as Error).message);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
// An editor opened (or reloaded with new tools) after the client connected: tell it.
setInterval(async () => {
  if (await refreshTools()) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
}, 5000).unref();
log(`ready (dev server ${BASE})`);
