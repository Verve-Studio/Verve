export function encodePng(data: Uint8Array, w: number, h: number): string {
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const ctx = tmp.getContext("2d")!;
  ctx.putImageData(
    new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer), w, h),
    0,
    0,
  );
  return tmp.toDataURL("image/png");
}

export function decodePng(
  dataUrl: string,
  w: number,
  h: number,
): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tmp = document.createElement("canvas");
      tmp.width = w;
      tmp.height = h;
      const ctx = tmp.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      resolve(new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer));
    };
    img.onerror = () => reject(new Error("Failed to decode PNG"));
    img.src = dataUrl;
  });
}
