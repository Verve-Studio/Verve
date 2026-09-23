/**
 * Filesystem locations the ML modules need. They used to read these from
 * Electron's `app` directly, which only exists in the main process; the
 * inference code now also runs in a utility process (see `mlHost.ts`), so
 * the main process resolves the paths once and hands them to the worker.
 */
export interface MlPaths {
  isPackaged: boolean
  /** `process.resourcesPath` of the packaged app (bundled models). */
  resourcesPath: string
  /** `app.getPath('userData')` (downloaded / user-supplied models). */
  userData: string
  /** Project root in development (`<root>/resources/models/...`). */
  appRoot: string
}

let paths: MlPaths | null = null

export function setMlPaths(p: MlPaths): void {
  paths = p
}

export function mlPaths(): MlPaths {
  if (!paths) throw new Error('ML model paths have not been initialised')
  return paths
}
