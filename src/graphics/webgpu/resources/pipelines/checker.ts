import { CHECKER_SHADER } from "../../shaders/rendering/checker";

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
