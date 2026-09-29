/**
 * WebGPU device/adapter setup. Requests the optional features the renderer can
 * use and records which ones were actually granted so subsystems can adapt.
 */

const WANTED_FEATURES: GPUFeatureName[] = [
  'timestamp-query',
  'texture-compression-bc',
  'depth-clip-control',
  'float32-filterable',
  'rg11b10ufloat-renderable',
  'shader-f16',
  'indirect-first-instance',
];

export interface GpuCaps {
  timestamps: boolean;
  bc: boolean;
  depthClipControl: boolean;
  float32Filterable: boolean;
  transientAttachments: boolean;
  adapterInfo: string;
}

export interface GpuContext {
  adapter: GPUAdapter;
  device: GPUDevice;
  canvas: HTMLCanvasElement;
  context: GPUCanvasContext;
  presentFormat: GPUTextureFormat;
  caps: GpuCaps;
}

export async function createGpuContext(canvas: HTMLCanvasElement): Promise<GpuContext> {
  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');

  const requiredFeatures = WANTED_FEATURES.filter((f) => adapter.features.has(f));
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
      maxTextureArrayLayers: L.maxTextureArrayLayers,
      maxSampledTexturesPerShaderStage: L.maxSampledTexturesPerShaderStage,
      maxStorageBuffersPerShaderStage: L.maxStorageBuffersPerShaderStage,
      maxColorAttachmentBytesPerSample: L.maxColorAttachmentBytesPerSample,
      maxComputeWorkgroupStorageSize: L.maxComputeWorkgroupStorageSize,
      maxComputeInvocationsPerWorkgroup: L.maxComputeInvocationsPerWorkgroup,
    },
  });

  device.lost.then((info) => {
    console.error('[gpu] device lost:', info.reason, info.message);
    const el = document.getElementById('fatal');
    if (el) {
      el.textContent = `GPU device lost: ${info.message}`;
      el.style.display = 'block';
    }
  });
  device.addEventListener('uncapturederror', (e) => {
    console.error('[gpu] uncaptured error:', (e as GPUUncapturedErrorEvent).error.message);
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('Could not create WebGPU canvas context.');
  const presentFormat = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format: presentFormat,
    alphaMode: 'opaque',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const info = adapter.info;
  const caps: GpuCaps = {
    timestamps: device.features.has('timestamp-query'),
    bc: device.features.has('texture-compression-bc'),
    depthClipControl: device.features.has('depth-clip-control'),
    float32Filterable: device.features.has('float32-filterable'),
    transientAttachments: typeof (GPUTextureUsage as unknown as Record<string, number>).TRANSIENT_ATTACHMENT === 'number',
    adapterInfo: `${info.vendor} ${info.architecture} ${info.description}`.trim(),
  };
  console.info('[gpu] features:', [...device.features].join(', '));
  return { adapter, device, canvas, context, presentFormat, caps };
}

/** Usage flag for MSAA/depth attachments that never need to leave tile memory. */
export function transientUsage(caps: GpuCaps): number {
  return caps.transientAttachments
    ? (GPUTextureUsage as unknown as Record<string, number>).TRANSIENT_ATTACHMENT
    : 0;
}
