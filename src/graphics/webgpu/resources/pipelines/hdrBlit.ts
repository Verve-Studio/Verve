import { HDR_BLIT_SHADER } from "../../shaders/rendering/blit";

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
              srcFactor: "src-alpha",
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

export function createHdrBlitBindGroupLayout(
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
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: "float",
          viewDimension: "2d",
          multisampled: false,
        },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.FRAGMENT,
        texture: {
          sampleType: "float",
          viewDimension: "2d",
          multisampled: false,
        },
      },
      {
        binding: 6,
        visibility: GPUShaderStage.FRAGMENT,
        sampler: { type: "filtering" },
      },
    ],
  });
}
