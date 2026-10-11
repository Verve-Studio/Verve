/** Path helpers for automation nodes (the renderer has no `node:path`).
 *  Both separators are accepted; joins use the folder's own separator. */

export function joinPath(folder: string, name: string): string {
  if (!folder) return name;
  if (!name) return folder;
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${name.replace(/^[\\/]+/, "")}`;
}

export interface PathParts {
  folder: string;
  /** File name with extension. */
  name: string;
  /** File name without extension. */
  stem: string;
  /** Extension without the dot, lower-case ("" when none). */
  extension: string;
}

export function splitPath(path: string): PathParts {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const folder = cut >= 0 ? path.slice(0, cut) : "";
  const name = path.slice(cut + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? { folder, name, stem: name.slice(0, dot), extension: name.slice(dot + 1).toLowerCase() }
    : { folder, name, stem: name, extension: "" };
}
