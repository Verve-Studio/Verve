cmake_minimum_required(VERSION 3.16)
project(pixelops CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

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
)

target_include_directories(pixelops PRIVATE src)

if(EMSCRIPTEN)
  # Output directory for the generated JS+WASM files
  set(OUTPUT_DIR "${CMAKE_SOURCE_DIR}/../src/wasm/generated")

  set_target_properties(pixelops PROPERTIES
    SUFFIX ".js"
  )

  target_link_options(pixelops PRIVATE
    "-sWASM=1"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createPixelOps"
    "-sEXPORTED_FUNCTIONS=_malloc,_free,_pixelops_flood_fill,_pixelops_convolve,_pixelops_resize_bilinear,_pixelops_resize_nearest,_pixelops_dither_bayer,_pixelops_quantize,_pixelops_curves_histogram,_pixelops_affine_transform,_pixelops_perspective_transform,_pixelops_inpaint,_pixelops_grabcut,_pixelops_grabcut_compute_beta,_pixelops_grabcut_kmeans_init,_pixelops_grabcut_update_gmms,_pixelops_grabcut_mincut,_matchPaletteIndices,_floodFillIndexed"
    "-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32"
    "-sALLOW_MEMORY_GROWTH=1"
    "-O2"
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
