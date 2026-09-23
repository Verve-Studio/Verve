# Issue tracker

Issues from the stability and performance code review of September 2026. The detail file for each issue has the problem, locations, suggested fix and "done when" criteria.

**Status values:** Open · In progress · Fixed · Won't fix. When you change a status, update it both here and in the detail file.

**Priority:** P0 = broken now / data loss · P1 = stability & security · P2 = performance · P3 = correctness (medium) · P4 = low.

| ID | Issue | Priority | Status |
|---|---|---|---|
| 001 | [Close All / Close Others only closes one tab](001-close-all-tabs-closes-one.md) | P0 | Fixed |
| 002 | [EXR export writes empty files (wasm64 struct layout)](002-exr-export-empty-files.md) | P0 | Fixed |
| 003 | [EXR decode truncates pointers to int32](003-exr-decode-pointer-truncation.md) | P0 | Fixed |
| 004 | [Two Bloom layers with different Quality freeze the canvas](004-bloom-destroys-in-use-textures.md) | P0 | Fixed |
| 005 | [Indexed8 Resize/Rotate/Flip silently fail above ~1024²](005-indexed8-transform-stack-overflow.md) | P0 | Fixed |
| 006 | [Pen strokes on indexed8 layers render transparent](006-indexed8-pen-batch-flush-no-palette.md) | P0 | Fixed |
| 007 | [Rotate/Flip corrupt rgba32f layers that aren't canvas-sized](007-rotate-flip-f32-non-canvas-layers.md) | P0 | Fixed |
| 008 | [Moving a selection only works on rgba8 and is O(canvas) per move](008-move-selection-rgba8-only.md) | P0 | Fixed |
| 009 | [Dodge/Burn corrupts rgba32f layers](009-dodge-burn-f32.md) | P0 | Fixed |
| 010 | [Eraser is broken on rgba32f](010-eraser-f32.md) | P0 | Fixed |
| 011 | [Magic Wand (and Quick Select) mis-select on rgba32f](011-magic-wand-quickselect-f32.md) | P0 | Fixed |
| 012 | [Content-Aware Fill / Generate Palette receive Float32 data as bytes](012-f32-composite-passed-as-uint8.md) | P0 | Fixed |
| 013 | [History de-dup can record the wrong pixels after a canvas remount](013-history-dedup-after-remount.md) | P0 | Fixed |
| 014 | [Preview-bypass state leaks into flatten / export / merge](014-preview-bypass-leaks-into-export.md) | P0 | Fixed |
| 015 | [Opening files races with tab switches and other opens](015-file-open-races.md) | P0 | Fixed |
| 016 | [Long async operations apply to whichever tab is active when they finish](016-async-transforms-wrong-tab.md) | P0 | Fixed |
| 017 | [Fill tool's async flood fill writes into a stale layer](017-fill-async-race-stale-layer.md) | P0 | Fixed |
| 018 | [`renderPlan` isn't exception-safe; one throw crops every later frame and export](018-renderplan-not-exception-safe.md) | P1 | Fixed |
| 019 | [`deferFlush` can stick on after a tool throws, so painting stops working](019-deferflush-stuck-after-throw.md) | P1 | Fixed |
| 020 | [Layers aren't freed on Canvas unmount (leak per tab switch / resize / crop)](020-renderer-destroy-leaks-layers.md) | P1 | Fixed |
| 021 | [Cached outputs of deleted standalone effects / adjustments are never evicted](021-standalone-effect-cache-leak.md) | P1 | Fixed |
| 022 | [Pixel copies for closed background tabs are never freed](022-closed-tab-transfer-store-leak.md) | P1 | Fixed |
| 023 | [WebGPU device loss isn't handled; canvas freezes silently](023-device-lost-handling.md) | P1 | Fixed |
| 024 | [WebGPU initialization failure shows a blank canvas with no message](024-webgpu-init-error-silent.md) | P1 | Fixed |
| 025 | [GPU readback path is fragile and GPU errors never surface](025-readback-fragility-error-scopes.md) | P1 | Fixed |
| 026 | [Switching tools mid-stroke leaks timers and loses/corrupts state](026-tool-switch-mid-stroke.md) | P1 | Fixed |
| 027 | [`.verve` save builds one giant JSON string and writes non-atomically](027-verve-save-format-atomic.md) | P1 | Fixed |
| 028 | [Open/save/transform errors are never shown to the user](028-file-and-operation-errors-not-surfaced.md) | P1 | Fixed |
| 029 | [Pixelate does S² work per pixel and can hang the GPU](029-pixelate-gpu-timeout.md) | P1 | Fixed |
| 030 | [Lens Blur runs up to ~31k taps × 4 loads per pixel](030-lens-blur-gpu-timeout.md) | P1 | Fixed |
| 031 | [Remove Motion Blur: GPU-timeout risk and per-encode full-res allocations](031-remove-motion-blur-gpu-timeout.md) | P1 | Fixed |
| 032 | [Motion Blur uses up to 999 bilinear taps in one pass](032-motion-blur-gpu-timeout.md) | P1 | Fixed |
| 033 | [Pinned `layer.data` views go stale after heap growth inside C++](033-wasm-heap-stale-views.md) | P1 | Fixed |
| 034 | [WASM `_malloc` results are never checked; an OOM corrupts memory](034-wasm-malloc-unchecked.md) | P1 | Fixed |
| 035 | [GrabCut's recursive max-flow DFS runs on a 64 KB stack](035-grabcut-recursive-dfs-stack.md) | P1 | Fixed |
| 036 | [GrabCut compute fails silently above ~33 MP (storage buffer limit)](036-grabcut-storage-buffer-limit.md) | P1 | Fixed |
| 037 | [All ML inference runs inside the Electron main process](037-ml-in-main-process.md) | P1 | Fixed |
| 038 | [No crash handling and no unsaved-changes guard on close](038-crash-handling-close-guard.md) | P1 | Fixed |
| 039 | [No single-instance lock](039-single-instance-lock.md) | P1 | Fixed |
| 040 | [ONNX sessions are never released and can be created twice](040-onnx-session-release.md) | P1 | Fixed |
| 041 | [History memory cap isn't applied to new tabs; no overall budget](041-history-memory-cap-per-tab.md) | P1 | Fixed |
| 042 | [Preload exposes unrestricted `ipcRenderer`; renderer is unsandboxed](042-preload-raw-ipcrenderer-sandbox.md) | P1 | Fixed |
| 043 | [`shell.openExternal` accepts any URL; navigation is unrestricted](043-openexternal-navigation.md) | P1 | Fixed |
| 044 | [Path traversal in colour-profile IPC allows arbitrary file delete/read](044-color-profile-path-traversal.md) | P1 | Fixed |
| 045 | [Generic file IPC reads/writes any path the renderer supplies](045-file-ipc-arbitrary-paths.md) | P1 | Fixed |
| 046 | [DevTools IPC handler is registered in production builds](046-devtools-in-production.md) | P1 | Fixed |
| 047 | [Pen strokes with Brush re-upload the whole layer every frame](047-brush-pen-double-flush-full-upload.md) | P2 | Fixed |
| 048 | [Compositor allocates full-canvas temporary textures every frame](048-per-frame-temp-textures.md) | P2 | Fixed |
| 049 | [Every state change re-renders the whole app](049-whole-app-rerender.md) | P2 | Fixed |
| 050 | [Menu tree is rebuilt on every render](050-menu-tree-rebuilt-every-render.md) | P2 | Fixed |
| 051 | [Navigator re-renders 60×/s even when idle](051-navigator-raf-loop.md) | P2 | Fixed |
| 052 | [Every `layers` change re-rasterizes all text/shape/path/frame layers](052-parametric-layers-rerasterized.md) | P2 | Fixed |
| 053 | [Text-edit effect re-runs on every Canvas render (every keystroke)](053-text-edit-effect-rerun.md) | P2 | Fixed |
| 054 | [File read, export, clipboard and print move image bytes as base64 strings](054-base64-ipc-transfer.md) | P2 | Fixed |
| 055 | [Single-layer HDR import does a needless base64 round trip](055-hdr-import-base64.md) | P2 | Fixed |
| 056 | [Internal paths use slow base64 / PNG encodings where transfer stores would do](056-slow-internal-encodings.md) | P2 | Fixed |
| 057 | [Heavy WASM work freezes the UI thread](057-wasm-main-thread.md) | P2 | Fixed |
| 058 | [Inpaint processes the whole canvas and the WASM heap never shrinks](058-inpaint-full-canvas-memory.md) | P2 | Fixed |
| 059 | [File-association IPC runs dozens of blocking child processes on the main thread](059-file-association-sync-processes.md) | P2 | Fixed |
| 060 | [Every indexed8 flush expands and uploads the whole layer](060-indexed8-full-flush.md) | P2 | Fixed |
| 061 | [Each airbrush (build-up) tick clears the whole canvas-sized touched buffer](061-airbrush-clears-touched-buffer.md) | P2 | Fixed |
| 062 | [Quick Select copies canvas-sized buffers per stamp](062-quickselect-copies-per-stamp.md) | P2 | Fixed |
| 063 | [Liquify allocates full-layer buffers at every stroke start](063-liquify-full-layer-alloc.md) | P2 | Fixed |
| 064 | [Blur/Sharpen/Smudge/Liquify ignore the selection, allocate per stamp, skip stroke brackets](064-local-brushes-selection-and-alloc.md) | P2 | Fixed |
| 065 | [Pencil does full-layer uploads on several paths](065-pencil-full-uploads.md) | P2 | Fixed |
| 066 | [Effect texture caches are evicted after any frame the effect doesn't encode](066-effect-cache-eviction-too-eager.md) | P2 | Fixed |
| 067 | [Expensive 2D kernels in Bilateral, Color Key dilation and Gaussian](067-heavy-2d-kernels.md) | P2 | Fixed |
| 068 | [Halation blurs at full resolution; Bloom keeps a full-res extract texture](068-halation-full-res.md) | P2 | Fixed |
| 069 | [Reduce Colors panel does a full readback + quantize on every slider tick](069-reduce-colors-readback-per-tick.md) | P2 | Fixed |
| 070 | [Upscale IPC doesn't validate target size and makes extra full-size copies](070-upscale-memory-validation.md) | P2 | Fixed |
| 071 | [Brush smudge on rgba32f gamma-decodes twice](071-brush-smudge-f32-double-decode.md) | P3 | Fixed |
| 072 | [Duplicate or empty history entries](072-duplicate-history-entries.md) | P3 | Fixed |
| 073 | [Several effects use 8-bit scratch textures on 32-bit float documents](073-effects-8bit-scratch-textures.md) | P3 | Fixed |
| 074 | [Reduce Colors and Color Dithering assume sRGB input](074-reduce-colors-dither-srgb-assumption.md) | P3 | Fixed |
| 075 | [Effect colour params are passed as `/255` sRGB into linear documents](075-effect-colors-not-linearized.md) | P3 | Fixed |
| 076 | [Median filter uses 256-bin histograms on linear floats](076-median-filter-f32.md) | P3 | Fixed |
| 077 | [Curves quantizes and clips on rgba32f; LUT is off by half a texel](077-curves-f32-lut.md) | P3 | Fixed |
| 078 | [`REMOVE_LAYER` leaves deleted ids in `selectedLayerIds`](078-remove-layer-selected-ids.md) | P3 | Fixed |
| 079 | [Merge / rasterize plans don't pass `pixelFormat` (defaults to rgba8)](079-rebuildplan-pixelformat.md) | P3 | Fixed |
| 080 | [History eviction recomputes total bytes on every loop pass](080-history-eviction-quadratic.md) | P4 | Fixed |
| 081 | [Plan fingerprinting builds strings every frame, including no-op frames](081-plan-fingerprint-strings.md) | P4 | Fixed |
| 082 | [Idle work runs when nothing has changed](082-idle-work-mirror-ants-bindgroup.md) | P4 | Fixed |
| 083 | [Curves rebuilds its LUTs and a signature string every frame](083-curves-per-frame-cpu.md) | P4 | Fixed |
| 084 | [Every effect creates new uniform buffers and bind groups per frame](084-per-frame-uniform-buffers.md) | P4 | Fixed |
| 085 | [DropShadow runs dilate passes even when spread is 0](085-dropshadow-spread-zero.md) | P4 | Fixed |
| 086 | [Invert produces negative values for HDR input](086-invert-hdr-negative.md) | P4 | Fixed |
| 087 | [LUT GPU cache is never evicted](087-lut-cache-never-evicted.md) | P4 | Fixed |
| 088 | [Healing Brush clips HDR and keeps source state across tabs](088-healing-brush-hdr-clamp-module-state.md) | P4 | Fixed |
| 089 | [Gradient allocates a tuple per pixel](089-gradient-per-pixel-alloc.md) | P4 | Fixed |
| 090 | [Lasso and Healing Brush copy the whole point array on every move](090-lasso-quadratic-copy.md) | P4 | Fixed |
| 091 | [Integer overflow in C++ index math for very large images](091-wasm-int-overflow.md) | P4 | Fixed |
| 092 | [Curves histogram bins saturate on large images](092-curves-histogram-float-bins.md) | P4 | Fixed |
| 093 | [Dock drag listeners are removed only on mouseup](093-dock-drag-listener-leak.md) | P4 | Fixed |
| 094 | [Clipboard encode/decode runs synchronously on the main process](094-clipboard-sync-encode.md) | P4 | Fixed |
| 095 | [A print job can leak its window and temp directory](095-print-job-leak.md) | P4 | Fixed |
| 096 | [Dead WASM exports and unused C++ filters](096-wasm-dead-code.md) | P4 | Fixed |
| 097 | [Check WebGPU enablement on Linux builds](097-linux-webgpu-flags.md) | P4 | Fixed |

## Painting system review (September 2026)

| ID | Issue | Priority | Status |
|---|---|---|---|
| 098 | [Eraser with Anti-alias off freezes the app](098-eraser-bresenham-hang.md) | P0 | Fixed |
| 099 | [Brush WASM path clips to a stale selection mask](099-brush-stale-wasm-selection.md) | P0 | Fixed |
| 100 | [Tiled mode: Brush strokes with a mouse are never uploaded](100-tiled-brush-no-upload.md) | P0 | Fixed |
| 101 | [Pen batches upload the full active layer every frame](101-pen-batch-full-upload.md) | P0 | Fixed |
| 102 | [A stroke can get stuck (no pointer-up, timers, strokeActive)](102-stroke-not-guaranteed-to-end.md) | P1 | Fixed |
| 103 | [Incremental composite is disabled during every stroke](103-stroke-full-recomposite.md) | P2 | Fixed |
| 104 | [Each stroke's undo entry is a full-layer copy](104-history-full-layer-copy.md) | P2 | Fixed |
| 105 | [Mouse input paints at half pressure](105-mouse-pressure-half.md) | P1 | Fixed |
| 106 | [Sharpen clips HDR; Healing ignores the selection; hard selections in Clone/Dodge](106-retouch-hdr-selection.md) | P1 | Fixed |
| 107 | [Brush stamp bounding box ignores angle, square tips and shear](107-brush-stamp-bbox.md) | P1 | Fixed |
| 108 | [Brush motion blur disables the WASM batch and flips render paths](108-brush-motion-blur-gating.md) | P2 | Fixed |
| 109 | [Bitmap stamp path snaps stamp centres to whole pixels](109-brush-bitmap-pixel-snap.md) | P3 | Fixed |
| 110 | [Brush scatter sub-stamps share one scatter distance](110-brush-scatter-count.md) | P3 | Fixed |
| 111 | [Brush direction dynamics: dead half-range and 0° seed](111-brush-direction-dynamics.md) | P3 | Fixed |
| 112 | [Brush build-up breaks wet edges](112-brush-buildup-wet-edges.md) | P3 | Fixed |
| 113 | [Brush colour pipeline clamps / mis-encodes HDR](113-brush-hdr-colour.md) | P3 | Fixed |
| 114 | [Smudge / Liquify / Healing pull black from transparent pixels](114-smudge-dark-fringes.md) | P3 | Fixed |
| 115 | [Brush layer growth padding ignores scatter and shear](115-brush-scatter-growth.md) | P3 | Fixed |
| 116 | [Tiled mode leaves stale coverage in `touched`](116-tiled-touched-stale.md) | P3 | Fixed |
| 117 | [Pencil capture-selection-as-brush is wrong for rgba32f/indexed8 and reads stale state](117-pencil-capture-brush.md) | P3 | Fixed |
| 118 | [Pencil pixel-brush selection desyncs from the UI](118-pencil-pixel-brush-state.md) | P3 | Fixed |
| 119 | [Pencil motion blur paints outside the dirty/growth pad](119-pencil-motion-blur-pad.md) | P3 | Fixed |
| 120 | [Pencil sizes don't match preview / indexed stamps](120-pencil-size-mismatch.md) | P3 | Fixed |
| 121 | [1 px anti-aliased eraser leaves partially erased beads](121-eraser-aa-beads.md) | P3 | Fixed |
| 122 | [Eraser defaults to painting the background colour; indexed8 ignores strength](122-eraser-default-mode.md) | P3 | Fixed |
| 123 | [Indexed8 pencil: no pixel-perfect, selection OOB, first-dab tiling, Map coverage](123-indexed-pencil-gaps.md) | P3 | Fixed |
| 124 | [Quick Select leaves seams and drops stamps](124-quickselect-seams.md) | P3 | Fixed |
| 125 | [Clone Stamp Sample All Layers: taps paint nothing; masks/adjustments ignored](125-clonestamp-sample-all.md) | P3 | Fixed |
| 126 | [Smudge and Blur can't extend beyond the layer rect](126-smudge-blur-growth.md) | P3 | Fixed |
| 127 | [No pointerId tracking or pointercancel handling](127-pointer-multi-cancel.md) | P3 | Fixed |
| 128 | [Airbrush build-up doesn't render with a pen](128-pen-buildup-no-render.md) | P3 | Fixed |
| 129 | [Full ToolContext built per coalesced sample; every sample replayed into all tools](129-per-sample-context.md) | P2 | Fixed |
| 130 | [Healing: full-layer uploads, no stroke throttle; Clone/Heal full copies per stroke](130-healing-perf.md) | P2 | Fixed |
| 131 | [Dodge/Burn allocates per pixel and grows the layer needlessly](131-dodge-perf.md) | P2 | Fixed |
| 132 | [Per-pixel allocation in samplePixel/blendPixelOver and pencil/eraser overdraw](132-pixel-write-overhead.md) | P2 | Fixed |
| 133 | [Mid-stroke thumbnail refresh, double upload on grow, zoom scans mask](133-stroke-misc-perf.md) | P2 | Fixed |
| 134 | [Brush allocates dozens of objects per stamp](134-brush-alloc-per-stamp.md) | P2 | Fixed |
| 135 | [Brush low-severity: spacing carry, tilt wrap, wet-edge format, SDF leak, batch flags](135-brush-low-misc.md) | P4 | Fixed |
| 136 | [Retouching low-severity: blur margin, sharpen space, liquify loop, object-removal scan, scope use](136-retouch-low-misc.md) | P4 | Fixed |
| 137 | [Dead painting code (unused primitives, newPixelLayerRef)](137-painting-dead-code.md) | P4 | Fixed |
