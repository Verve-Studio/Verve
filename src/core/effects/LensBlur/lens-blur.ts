import {
  createUniformBuffer,
  writeUniformBuffer,
  createReadbackBuffer,
  unpackRows,
} from "@/graphicspipeline/webgpu/utils";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";
export function buildKernelEntries(
  radius: number,
  bladeCount: number,
  bladeCurvature: number,
  rotation: number,
): Float32Array {
  const PI = Math.PI;
  const bladeCurvF = bladeCurvature / 100.0;
  const rotRad = (rotation * PI) / 180.0;
  const bladeAngle = bladeCurvature < 100 ? (2.0 * PI) / bladeCount : 0.0;
  const halfBlade = bladeAngle / 2.0;
  const polyInradius = bladeCurvature < 100 ? Math.cos(PI / bladeCount) : 1.0;

  const entries: Array<[number, number, number]> = [];
  for (let ky = -radius; ky <= radius; ky++) {
    for (let kx = -radius; kx <= radius; kx++) {
      const nx = radius > 0 ? kx / radius : 0.0;
      const ny = radius > 0 ? ky / radius : 0.0;
      const r = Math.sqrt(nx * nx + ny * ny);
      if (r > 1.5) continue;

      let w: number;
      if (bladeCurvature >= 100) {
        w = r <= 1.0 ? 1.0 : 0.0;
      } else {
        const theta = Math.atan2(ny, nx) + rotRad;
        const sector =
          (((theta + 20.0 * PI) % bladeAngle) + bladeAngle) % bladeAngle;
        const polyR = polyInradius / Math.cos(sector - halfBlade);
        const effectiveR = polyR * (1.0 - bladeCurvF) + 1.0 * bladeCurvF;
        w = r <= effectiveR ? 1.0 : 0.0;
      }
      if (w > 0) entries.push([kx, ky, w]);
    }
  }

  const sum = entries.reduce((acc, e) => acc + e[2], 0);
  const inv = sum > 0 ? 1.0 / sum : 1.0;

  const result = new Float32Array(entries.length * 4);
  for (let i = 0; i < entries.length; i++) {
    result[i * 4 + 0] = entries[i][0];
    result[i * 4 + 1] = entries[i][1];
    result[i * 4 + 2] = entries[i][2] * inv;
    result[i * 4 + 3] = 0;
  }
  return result;
}

export async function runLensBlur(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  pixels: Uint8Array,
  w: number,
  h: number,
  kernelBuf: GPUBuffer,
  kernelCount: number,
): Promise<Uint8Array> {
  const smp = device.createSampler({
    magFilter: "nearest",
    minFilter: "nearest",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });

  const srcTex = createTrackedTexture(device, {
    size: { width: w, height: h },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture: srcTex },
    pixels as Uint8Array<ArrayBuffer>,
    { bytesPerRow: w * 4, rowsPerImage: h },
    { width: w, height: h },
  );

  const outTex = createTrackedTexture(device, {
    size: { width: w, height: h },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const paramsData = new Uint32Array([kernelCount, 0, 0, 0]);
  const paramsBuf = createUniformBuffer(device, 16);
  writeUniformBuffer(device, paramsBuf, paramsData);

  const encoder = device.createCommandEncoder();
  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: srcTex.createView() },
      { binding: 1, resource: smp },
      { binding: 2, resource: { buffer: paramsBuf } },
      { binding: 3, resource: { buffer: kernelBuf } },
    ],
  });
  const pass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: outTex.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
      },
    ],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(6);
  pass.end();

  const alignedBpr = Math.ceil((w * 4) / 256) * 256;
  const readbuf = createReadbackBuffer(device, alignedBpr * h);
  encoder.copyTextureToBuffer(
    { texture: outTex },
    { buffer: readbuf, bytesPerRow: alignedBpr, rowsPerImage: h },
    { width: w, height: h },
  );

  device.queue.submit([encoder.finish()]);

  await readbuf.mapAsync(GPUMapMode.READ);
  const result = unpackRows(
    new Uint8Array(readbuf.getMappedRange()),
    w,
    h,
    alignedBpr,
  );
  readbuf.unmap();

  destroyTrackedTexture(srcTex);
  destroyTrackedTexture(outTex);
  paramsBuf.destroy();
  readbuf.destroy();

  return result;
}
