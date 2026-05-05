import {
  COMPOSITE_SHADER,
  CHECKER_SHADER,
  HDR_BLIT_SHADER,
} from "../shaders/shaders";

/**
 * Standard interleaved layout used by every composite/checker/blit pipeline:
 * vertex buffer 0 = position (vec2f), buffer 1 = texcoord (vec2f). Both 8-byte
 * stride, both at attribute offset 0.
 */
const VERTEX_BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 8,
    attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
  },
  {
    arrayStride: 8,
    attributes: [{ shaderLocation: 1, offset: 0, format: "float32x2" }],
  },
];

/**
 * Composite pipeline writes layer pixels into the internal ping-pong textures
 * (rgba8unorm or rgba32float). Uses an explicit BGL so rgba32float layer
 * textures are accepted (auto-layout would infer sampleType:'float').
 */
export function createCompositePipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  bgl: GPUBindGroupLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: COMPOSITE_SHADER });
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module, entryPoint: "vs_composite", buffers: VERTEX_BUFFERS },
    fragment: { module, entryPoint: "fs_composite", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

/** Checker pipeline draws the transparency checkerboard directly to the screen. */
export function createCheckerPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: CHECKER_SHADER });
  return device.createRenderPipeline({
    layout: "auto",
    vertex: { module, entryPoint: "vs_checker", buffers: VERTEX_BUFFERS },
    fragment: { module, entryPoint: "fs_checker", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
}

/**
 * HDR blit pipeline tone-maps the internal composite into the swapchain. Uses
 * src-over blending so the checker pass beneath shows through transparent
 * regions of the composite.
 */
export function createHdrBlitPipeline(
  device: GPUDevice,
  format: GPUTextureFormat,
  bgl: GPUBindGroupLayout,
): GPURenderPipeline {
  const module = device.createShaderModule({ code: HDR_BLIT_SHADER });
  return device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module, entryPoint: "vs_blit", buffers: VERTEX_BUFFERS },
    fragment: {
      module,
      entryPoint: "fs_blit",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });
}
