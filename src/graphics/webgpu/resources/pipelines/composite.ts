import { COMPOSITE_SHADER } from "../../shaders/rendering/composite";

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

export function createCompositeBindGroupLayout(
  device: GPUDevice,
): GPUBindGroupLayout {
  return device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "non-filtering" },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: "unfilterable-float",
          viewDimension: "2d",
          multisampled: false,
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: "unfilterable-float",
          viewDimension: "2d",
          multisampled: false,
        },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: "unfilterable-float",
          viewDimension: "2d",
          multisampled: false,
        },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: "float",
          viewDimension: "2d",
          multisampled: false,
        },
      },
      {
        binding: 7,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: "float",
          viewDimension: "2d",
          multisampled: false,
        },
      },
      {
        binding: 8,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
    ],
  });
}
