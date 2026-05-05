import {
  createUniformBuffer,
  writeUniformBuffer,
  createReadbackBuffer,
  unpackRows,
} from "../../../utils";
import {
  createTrackedTexture,
  destroyTrackedTexture,
} from "@/core/store/memoryStore";

import FILTER_LENS_FLARE_COMPUTE from "./wgsl/filter-lens-flare.wgsl?raw";
export { FILTER_LENS_FLARE_COMPUTE };

export async function runRenderLensFlare(
  device: GPUDevice,
  pipeline: GPURenderPipeline,
  w: number,
  h: number,
  centerX: number,
  centerY: number,
  brightness: number,
  lensType: number,
  ringOpacity: number,
  streakStrength: number,
  streakWidth: number,
  streakRotation: number,
): Promise<Uint8Array> {
  const outTex = createTrackedTexture(device, {
    size: { width: w, height: h },
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  const paramsData = new Uint32Array([
    Math.round(centerX),
    Math.round(centerY),
    brightness,
    lensType,
    ringOpacity,
    streakStrength,
    streakWidth,
    streakRotation,
    w,
    h,
    0,
    0,
  ]);
  const paramsBuf = createUniformBuffer(device, 48);
  writeUniformBuffer(device, paramsBuf, paramsData);

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: paramsBuf } }],
  });

  const encoder = device.createCommandEncoder();
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

  destroyTrackedTexture(outTex);
  paramsBuf.destroy();
  readbuf.destroy();

  return result;
}
