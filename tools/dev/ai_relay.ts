// AI relay (vite plugin, dev only): lets an external agent (the MCP server in
// tools/mcp/rill-mcp.ts, or any local script) call the editor's structured tools.
//
//   POST /__ai/call   { name, params, timeoutMs? } -> { ok, result } | { ok: false, error }
//   GET  /__ai/status                              -> connected editor tabs
//   GET  /__ai/tools                               -> tool catalogue of the active editor
//
// Calls travel over Vite's HMR websocket to the most recently active editor tab
// (custom events rill:ai-*), run through EditorTools.call there - the same
// operations the editor UI uses - and the result comes back the same way.
import type { Plugin, WebSocketClient } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CACHE = join(import.meta.dirname, '..', '..', 'build', 'ai', 'tools.json');

interface EditorTab {
  client: WebSocketClient;
  session: string;
  map: string;
  tools: unknown[];
  conventions?: string;
  connectedAt: number;
  lastSeen: number;
}

interface Pending {
  resolve: (v: { ok: boolean; result?: unknown; error?: string }) => void;
  timer: ReturnType<typeof setTimeout>;
}

// On globalThis: survives vite re-instantiating the plugin on config edits.
const G = globalThis as unknown as { __rillAi?: { tabs: Map<string, EditorTab>; pending: Map<string, Pending>; seq: number } };
const state = (G.__rillAi ??= { tabs: new Map(), pending: new Map(), seq: 0 });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * The editor tab calls go to: among tabs whose websocket is still open, the most
 * recently active one. (Liveness comes from the socket, not from pings: a hidden
 * background tab throttles its timers but still answers.)
 */
function activeTab(): EditorTab | null {
  let best: EditorTab | null = null;
  for (const [k, t] of state.tabs) {
    if (t.client.socket.readyState !== 1) { state.tabs.delete(k); continue; }
    if (!best || t.lastSeen > best.lastSeen) best = t;
  }
  return best;
}

export function aiRelay(): Plugin {
  return {
    name: 'rill-ai-relay',
    configureServer(server) {
      server.ws.on('rill:ai-register', (data: { session: string; map: string; tools: unknown[]; conventions?: string }, client) => {
        const prev = state.tabs.get(data.session);
        state.tabs.set(data.session, { client, session: data.session, map: data.map, tools: data.tools ?? prev?.tools ?? [], conventions: data.conventions, connectedAt: prev?.connectedAt ?? Date.now(), lastSeen: Date.now() });
        // The MCP server lists tools from this cache when no editor is open yet.
        try {
          mkdirSync(join(CACHE, '..'), { recursive: true });
          writeFileSync(CACHE, JSON.stringify({ tools: data.tools, conventions: data.conventions, savedAt: Date.now() }));
        } catch { /* cache is optional */ }
      });
      server.ws.on('rill:ai-ping', (data: { session: string }, client) => {
        const t = state.tabs.get(data.session);
        if (t) { t.lastSeen = Date.now(); t.client = client; }
      });
      server.ws.on('rill:ai-result', (data: { id: string; ok: boolean; result?: unknown; error?: string }) => {
        const p = state.pending.get(data.id);
        if (!p) return;
        clearTimeout(p.timer);
        state.pending.delete(data.id);
        p.resolve({ ok: data.ok, result: data.result, error: data.error });
      });

      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.startsWith('/__ai/')) return next();
        try {
          if (path === '/__ai/status' && req.method === 'GET') {
            const now = Date.now();
            activeTab();
            return json(res, 200, { editors: [...state.tabs.values()].map((t) => ({ map: t.map, session: t.session, connectedAt: t.connectedAt, idleMs: now - t.lastSeen })), active: activeTab()?.session ?? null });
          }
          if (path === '/__ai/tools' && req.method === 'GET') {
            const t = activeTab();
            if (!t) return json(res, 503, { error: 'no editor open: open http://localhost:5173/?map=<map> in a browser' });
            return json(res, 200, { map: t.map, tools: t.tools, conventions: t.conventions });
          }
          if (path === '/__ai/call' && req.method === 'POST') {
            const { name, params, timeoutMs } = JSON.parse(await readBody(req)) as { name: string; params?: unknown; timeoutMs?: number };
            const t = activeTab();
            if (!t) return json(res, 503, { ok: false, error: 'no editor open: open http://localhost:5173/?map=<map> in a browser' });
            const id = `ai_${++state.seq}_${Date.now().toString(36)}`;
            const out = await new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
              const timer = setTimeout(() => {
                state.pending.delete(id);
                resolve({ ok: false, error: `editor did not answer within ${Math.round((timeoutMs ?? 120000) / 1000)} s` });
              }, timeoutMs ?? 120000);
              state.pending.set(id, { resolve, timer });
              t.client.send('rill:ai-call', { id, name, params: params ?? {} });
            });
            return json(res, out.ok ? 200 : 400, out);
          }
          return json(res, 404, { error: 'unknown AI endpoint' });
        } catch (e) {
          return json(res, 500, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}
