# Verve integration notes for the lcms2 vendor drop

Maintainer-facing notes on how this directory plugs into the WASM build.
The upstream `README.md` and `COPYING` files travel unchanged.

## How CMake picks it up

`wasm/CMakeLists.txt` checks for two specific paths on configure:

```
wasm/src/vendor/lcms2/src/        (must contain *.c)
wasm/src/vendor/lcms2/include/lcms2.h
```

When both exist, it globs `src/*.c` into the `pixelops` target and adds
`include/` to the include path. CMake configure prints:

```
Verve: lcms2 detected at src/vendor/lcms2/, color management enabled.
```

When either is missing, the cms_* exports are dropped from
`-sEXPORTED_FUNCTIONS` and `cms_bindings.cpp` compiles to an empty TU
(its body is guarded by `#if __has_include("vendor/lcms2/include/lcms2.h")`).
The runtime feature-detects via `typeof module._cms_create_transform`,
so the rest of the app gracefully degrades to Tier-1 passthrough.

## What the bindings expose

`wasm/src/cms_bindings.cpp` wraps six lcms2 entry points:

| Symbol                       | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `_cms_get_working_profile`   | Generate canonical sRGB / linear-sRGB profile bytes  |
| `_cms_free_buffer`           | Free a buffer returned by `_cms_get_working_profile` |
| `_cms_create_transform`      | Compile a transform from two profile blobs           |
| `_cms_transform_apply`       | Apply a compiled transform to RGBA pixels            |
| `_cms_destroy_transform`     | Release a transform handle                           |
| `_cms_build_3d_lut`          | Sample a 3D LUT for GPU display-profile correction   |

TypeScript wrapper: [src/core/cms/lcms2.ts](../../../../src/core/cms/lcms2.ts).

## Verifying it's working after `npm run build:wasm`

1. Open a wide-gamut image (e.g. a Display P3 PNG from an iPhone, or any
   AdobeRGB photo).
2. The Info panel's "ICC" row should read **sRGB IEC61966-2.1** (or
   **linear-sRGB** for an rgba32f document), not the source profile name.
   That's the early-binding conversion writing the working-space tag.
3. Without the WASM rebuild in place, the same image still imports — but
   the Info row keeps showing the source profile name and pixels carry
   the source-profile colour values (Tier-1 passthrough behaviour).

## Updating the vendored source

To pull a newer lcms2 release:

```sh
git clone --depth 1 https://github.com/mm2/Little-CMS.git /tmp/lcms2
rm -rf wasm/src/vendor/lcms2/src wasm/src/vendor/lcms2/include
cp -r /tmp/lcms2/src     wasm/src/vendor/lcms2/src
cp -r /tmp/lcms2/include wasm/src/vendor/lcms2/include
npm run build:wasm
```

Verve uses only the public C API (functions declared in `lcms2.h`), so
patch-level updates should drop in without code changes. Major-version
updates would require revisiting `cms_bindings.cpp` for API breakage —
none expected for lcms2 v2.x.
