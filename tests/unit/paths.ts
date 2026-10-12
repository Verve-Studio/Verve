// Repository locations for tests that read source files or bundled resources.
import { resolve } from 'path'

export const REPO_ROOT = resolve(__dirname, '../..')
export const SRC_DIR = resolve(REPO_ROOT, 'src')
export const ELECTRON_DIR = resolve(REPO_ROOT, 'electron')
