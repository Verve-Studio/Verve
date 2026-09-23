# 044 · Path traversal in colour-profile IPC allows arbitrary file delete/read

| Field | Value |
|---|---|
| Status | Fixed |
| Priority | P1 |
| Severity | Medium |
| Category | Security |
| Area | Electron main / Color profiles |
| Verified | No — reported by reviewer |

## Problem
Profile ids `usr:<name>` / `sys:<name>` are joined straight into a directory path. `cms:deleteUserProfile('usr:..\\..\\..\\Documents\\x.psd')` unlinks any user-writable file; `readProfileBytes` reads arbitrary files the same way. `importProfileDialog` copies the picked file under its own name without sanitising.

## Where
- `electron/main/colorProfiles.ts:143, 154, 177, 196-199`

## Suggested fix
Reject names where `basename(name) !== name` or that contain `..` or separators; then check `resolve(join(dir, name)).startsWith(resolve(dir) + sep)`. Apply the same helper in `importProfileDialog`.

## Done when
- Traversal ids are rejected with an error; normal profile operations still work.


## Resolution
Added `safeJoin()` in `colorProfiles.ts`: a profile name must be a plain file name (`basename(name) === name`, not `.`/`..`) and the resolved path must stay inside the profile directory. It is used by `cms:readProfileBytes` (user and system) and `cms:deleteUserProfile`; traversal ids are rejected. `importProfileDialog` already stores the file under `basename()` of the file the user picked.
