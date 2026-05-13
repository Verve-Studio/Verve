cmake_minimum_required(VERSION 3.16)
project(pixelops C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)

add_executable(pixelops
  src/pixelops.cpp
  src/fill.cpp
  src/filters.cpp
  src/quantize.cpp
  src/resize.cpp
  src/dither.cpp
  src/curves_histogram.cpp
  src/transform.cpp
  src/inpaint.cpp
  src/grabcut.cpp
  src/brush_stamp.cpp
  src/exr.cpp
  src/dds.cpp
  src/cms_bindings.cpp
  src/vendor/rgbcx.cpp
  src/vendor/bc7enc.cpp
)

target_include_directories(pixelops PRIVATE src src/vendor)
target_compile_definitions(pixelops PRIVATE BC7ENC_USE_SSE2=0 BC7ENC_USE_SSE41=0)

# ─── lcms2 (color management) ────────────────────────────────────────────────
# Vendored at src/vendor/lcms2/ — see that directory's README for drop
# instructions. When the directory is present we glob its src/*.c files and
# add them to the build; when absent, cms_bindings.cpp compiles to a no-op
# (guarded by `#if __has_include`) and the TS side feature-detects the
# missing exports. The cms_* exports below are only useful with lcms2 linked.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/lcms2/src" AND
   EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/lcms2/include/lcms2.h")
  file(GLOB LCMS2_SOURCES "${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/lcms2/src/*.c")
  target_sources(pixelops PRIVATE ${LCMS2_SOURCES})
  target_include_directories(pixelops PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src/vendor/lcms2/include")
  set(VERVE_HAS_LCMS2 TRUE)
  message(STATUS "Verve: lcms2 detected at src/vendor/lcms2/, color management enabled.")
else()
  set(VERVE_HAS_LCMS2 FALSE)
  message(STATUS "Verve: lcms2 not vendored, color management disabled. "
                 "Drop sources into src/vendor/lcms2/ and rebuild to enable.")
endif()

if(EMSCRIPTEN)
  # Output directory for the generated JS+WASM files
  set(OUTPUT_DIR "${CMAKE_SOURCE_DIR}/../src/wasm/generated")

  # Base export list — pixelops + I/O. CMS exports are appended below when
  # lcms2 is vendored so the linker doesn't fail on undefined symbols.
  set(VERVE_EXPORTED_FUNCTIONS
    "_malloc,_free,_pixelops_flood_fill,_pixelops_flood_fill_f32,_pixelops_convolve,_pixelops_resize_bilinear,_pixelops_resize_nearest,_pixelops_dither_bayer,_pixelops_quantize,_pixelops_curves_histogram,_pixelops_affine_transform,_pixelops_perspective_transform,_pixelops_rotate_rgba,_pixelops_flip_rgba,_pixelops_rotate_indexed,_pixelops_flip_indexed,_pixelops_inpaint,_pixelops_grabcut,_pixelops_grabcut_compute_beta,_pixelops_grabcut_kmeans_init,_pixelops_grabcut_update_gmms,_pixelops_grabcut_mincut,_matchPaletteIndices,_floodFillIndexed,_loadExr,_freeExrResult,_saveExr,_freeExrBytes,_loadExrLayers,_freeExrLayersResult,_saveExrLayers,_pixelops_dds_get_info,_pixelops_dds_decode,_pixelops_dds_decode_f32,_pixelops_dds_get_encoded_size,_pixelops_dds_max_mip_levels,_pixelops_dds_encode,_pixelops_dds_encode_f32,_pixelops_brush_stamp,_pixelops_brush_stamp_batch,_pixelops_brush_bake_coverage,_pixelops_brush_stamp_bitmap,_pixelops_brush_stamp_bitmap_batch"
  )
  if(VERVE_HAS_LCMS2)
    set(VERVE_EXPORTED_FUNCTIONS
      "${VERVE_EXPORTED_FUNCTIONS},_cms_get_working_profile,_cms_free_buffer,_cms_create_transform,_cms_transform_apply,_cms_destroy_transform,_cms_build_3d_lut"
    )
  endif()

  set_target_properties(pixelops PROPERTIES
    SUFFIX ".js"
  )

  # Make the Emscripten zlib port headers available at compile time.
  # `-msimd128` enables WebAssembly SIMD128 — auto-vectorisation kicks in
  # for tight numeric loops (the brush stamp inner pixel loop, filters,
  # resize, etc.), and `<wasm_simd128.h>` intrinsics become available for
  # any code that wants to write explicit SIMD. Safe target: SIMD has been
  # default-enabled in Chromium ≥ 91 (May 2021) and Firefox ≥ 89, and
  # Verve runs in Electron (bundled Chromium) so there's no fallback
  # browser to worry about.
  target_compile_options(pixelops PRIVATE
    "-sUSE_ZLIB=1"
    "-msimd128"
    "-sMEMORY64=2"
  )

  target_link_options(pixelops PRIVATE
    "-sUSE_ZLIB=1"
    "-sWASM=1"
    "-msimd128"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createPixelOps"
    "-sEXPORTED_FUNCTIONS=${VERVE_EXPORTED_FUNCTIONS}"
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32"
    "-sALLOW_MEMORY_GROWTH=1"
    # ── wasm64 + 16 GB cap ───────────────────────────────────────────────
    # MEMORY64=2 enables wasm64 (i64 pointers internally, allowing >4 GB
    # heaps) BUT keeps the JS↔wasm boundary using regular Numbers via
    # Emscripten's compat conversion. Our TS code treats ptrs as `number`
    # everywhere — works as-is because 16 GB = 2^34 fits well inside
    # Number's 2^53 safe-integer range, no precision loss.
    # Browser support: enabled by default in Chromium ≥ 119 (Nov 2023);
    # Verve runs in Electron's bundled Chromium so there's no fallback
    # browser to worry about.
    # Without this, layer.data + touched + ping/pong textures on big rgba32f
    # docs blow past the wasm32 4 GB cap and `_malloc` silently returns 0
    # — the brush falls back to the slow slice-marshalling path.
    "-sMEMORY64=2"
    "-sMAXIMUM_MEMORY=16GB"
    # 512 MB starting heap so small/medium docs don't pay any growth cost;
    # growth to 16 GB still works thanks to ALLOW_MEMORY_GROWTH.
    "-sINITIAL_MEMORY=512MB"
    "-O3"
  )

  # Copy built outputs to src/wasm/generated/ so Vite can bundle them
  add_custom_command(TARGET pixelops POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${CMAKE_CURRENT_BINARY_DIR}/pixelops.js"
      "${OUTPUT_DIR}/pixelops.js"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different
      "${CMAKE_CURRENT_BINARY_DIR}/pixelops.wasm"
      "${OUTPUT_DIR}/pixelops.wasm"
    COMMENT "Copying WASM outputs to src/wasm/generated/"
  )
else()
  message(FATAL_ERROR
    "This project must be built with Emscripten.\n"
    "Run:  emcmake cmake -S wasm -B wasm/build\n"
    "Then: cmake --build wasm/build")
endif()
