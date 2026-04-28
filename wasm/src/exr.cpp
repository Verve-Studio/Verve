/**
 * exr.cpp
 *
 * OpenEXR encode/decode via tinyexr (header-only).
 * https://github.com/syoyo/tinyexr
 *
 * Expected build: add tinyexr.h to wasm/src/ (download from the repo above).
 * tinyexr.h is not vendored here because of its size; the build will fail with
 * a clear error if it is missing.
 *
 * Exported functions:
 *   loadExr(srcPtr, srcLen) → ptr to ExrResult struct or 0 on failure
 *   freeExrResult(ptr)
 *   saveExr(pixelsPtr, width, height, compression, halfFloat) → ptr to ExrBytes or 0
 *   freeExrBytes(ptr)
 *
 * Result structs are allocated with new and freed by the corresponding free
 * function.  The pixel / byte buffers inside are also heap-allocated and freed
 * together with the enclosing struct.
 */

#define TINYEXR_USE_MINIZ 0
#define TINYEXR_IMPLEMENTATION
#include <zlib.h>
#include "tinyexr.h"

#include <emscripten/emscripten.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>

// ─── Result structs ───────────────────────────────────────────────────────────

struct ExrResult {
    int         width;
    int         height;
    float*      pixels;  // RGBA float32, width*height*4 floats
};

struct ExrBytes {
    unsigned char* data;
    int            size;
};

extern "C" {

// ─── Decode ───────────────────────────────────────────────────────────────────

/**
 * Decode an OpenEXR blob into RGBA float32 pixels.
 * Returns a pointer to an ExrResult struct, or 0 on failure.
 * Caller must free with freeExrResult.
 */
EMSCRIPTEN_KEEPALIVE
ExrResult* loadExr(const unsigned char* src, int srcLen) {
    float* out   = nullptr;
    int    width = 0, height = 0;
    const char* err = nullptr;

    // LoadEXRFromMemory returns 0 on success
    int ret = LoadEXRFromMemory(&out, &width, &height, src, (size_t)srcLen, &err);
    if (ret != TINYEXR_SUCCESS) {
        if (err) FreeEXRErrorMessage(err);
        return nullptr;
    }

    // tinyexr returns RGB or RGBA; ensure RGBA by expanding if needed.
    // LoadEXRFromMemory always returns 4 channels (RGBA) per its docs.
    ExrResult* result = new ExrResult{ width, height, out };
    return result;
}

EMSCRIPTEN_KEEPALIVE
void freeExrResult(ExrResult* r) {
    if (!r) return;
    free(r->pixels);   // allocated by tinyexr with malloc
    delete r;
}

// ─── Encode ───────────────────────────────────────────────────────────────────

/**
 * Encode RGBA float32 pixels to an OpenEXR blob.
 * compression: 0=none, 1=zip (per scanline), 2=zips (per scanline group),
 *              3=piz (wavelet, smaller files)
 * halfFloat:   0 = full float32, 1 = half float16 (lossy, ~half size)
 * Returns a pointer to an ExrBytes struct, or 0 on failure.
 * Caller must free with freeExrBytes.
 */
EMSCRIPTEN_KEEPALIVE
ExrBytes* saveExr(const float* pixels, int width, int height, int compression, int halfFloat) {
    EXRHeader  header;
    EXRImage   image;
    InitEXRHeader(&header);
    InitEXRImage(&image);

    image.num_channels = 4;
    image.width        = width;
    image.height       = height;

    // tinyexr expects separate channel arrays (planar), in BGRA order by convention.
    std::vector<float> channelB(width * height);
    std::vector<float> channelG(width * height);
    std::vector<float> channelR(width * height);
    std::vector<float> channelA(width * height);

    for (int i = 0; i < width * height; i++) {
        channelR[i] = pixels[i * 4 + 0];
        channelG[i] = pixels[i * 4 + 1];
        channelB[i] = pixels[i * 4 + 2];
        channelA[i] = pixels[i * 4 + 3];
    }

    float* image_ptr[4] = {
        channelA.data(),
        channelB.data(),
        channelG.data(),
        channelR.data(),
    };
    image.images = reinterpret_cast<unsigned char**>(image_ptr);

    header.num_channels = 4;
    header.channels     = new EXRChannelInfo[4];
    strncpy(header.channels[0].name, "A", 255); header.channels[0].name[255] = '\0';
    strncpy(header.channels[1].name, "B", 255); header.channels[1].name[255] = '\0';
    strncpy(header.channels[2].name, "G", 255); header.channels[2].name[255] = '\0';
    strncpy(header.channels[3].name, "R", 255); header.channels[3].name[255] = '\0';

    header.pixel_types           = new int[4];
    header.requested_pixel_types = new int[4];
    const int pixType = halfFloat ? TINYEXR_PIXELTYPE_HALF : TINYEXR_PIXELTYPE_FLOAT;
    for (int c = 0; c < 4; c++) {
        header.pixel_types[c]           = TINYEXR_PIXELTYPE_FLOAT;
        header.requested_pixel_types[c] = pixType;
    }

    // Map compression index to tinyexr constant
    int compressionType = TINYEXR_COMPRESSIONTYPE_NONE;
    switch (compression) {
        case 1: compressionType = TINYEXR_COMPRESSIONTYPE_ZIP;  break;
        case 2: compressionType = TINYEXR_COMPRESSIONTYPE_ZIPS; break;
        case 3: compressionType = TINYEXR_COMPRESSIONTYPE_PIZ;  break;
        default: break;
    }
    header.compression_type = compressionType;

    unsigned char* outBuf  = nullptr;
    const char*    err     = nullptr;

    // SaveEXRImageToMemory returns the number of bytes written (0 on error).
    size_t outSize = SaveEXRImageToMemory(&image, &header, &outBuf, &err);

    delete[] header.channels;
    delete[] header.pixel_types;
    delete[] header.requested_pixel_types;

    if (outSize == 0 || outBuf == nullptr) {
        if (err) FreeEXRErrorMessage(err);
        return nullptr;
    }

    ExrBytes* result = new ExrBytes{ outBuf, static_cast<int>(outSize) };
    return result;
}

EMSCRIPTEN_KEEPALIVE
void freeExrBytes(ExrBytes* b) {
    if (!b) return;
    free(b->data);   // allocated by tinyexr with malloc
    delete b;
}

} // extern "C"
