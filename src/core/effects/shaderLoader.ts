const modules = import.meta.glob<string>("./**/*.wgsl", {
  query: "?raw",
  import: "default",
  eager: true,
});

const shaders: Record<string, string> = {};
for (const [path, source] of Object.entries(modules)) {
  // path looks like "./Bloom/bloom-extract.wgsl"
  const basename = path.split("/").pop()!.replace(/\.wgsl$/, "");
  if (basename in shaders) {
    throw new Error(`[shaderLoader] duplicate shader name: ${basename}`);
  }
  shaders[basename] = source;
}

export function getShader(name: string): string {
  const s = shaders[name];
  if (s === undefined) {
    throw new Error(`[shaderLoader] unknown shader: ${name}`);
  }
  return s;
}
