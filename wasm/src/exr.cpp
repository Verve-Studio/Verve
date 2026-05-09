/**
 * exr.cpp
 *
 * OpenEXR encode/decode via tinyexr (header-only).
 * https://github.com/syoyo/tinyexr
 *
 * Single-image API: loadExr / saveExr.
 * Multi-layer API:  loadExrLayers / saveExrLayers
 *   - loadExrLayers handles BOTH multi-part EXR files AND single-part files
 *     with channel-naming convention "<LayerName>.R/G/B/A".  Channels lacking
 *     a "." prefix go into a default layer named "" (rendered as "Background"
 *     by the JS side).
 *   - saveExrLayers writes a single-part EXR with channel-named layers
 *     ("<LayerName>.R/G/B/A").  All layers must already be sized to the full
 *     canvas (offsets baked in by the caller).
 */

#define TINYEXR_USE_MINIZ 0
#define TINYEXR_IMPLEMENTATION
#include <zlib.h>
#include "tinyexr.h"

#include <emscripten/emscripten.h>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <string>
#include <vector>

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

// Multi-layer decode result.  Layout chosen so that the JS side can walk it
// with a DataView using fixed offsets.  All pointers are into the WASM heap.
struct ExrLayerOut {
    int    width;       // 0
    int    height;      // 4
    int    offsetX;     // 8
    int    offsetY;     // 12
    int    namePtr;     // 16  (char* — null-terminated UTF-8 string)
    int    pixelsPtr;   // 20  (float* — width*height*4 RGBA float32)
};
static_assert(sizeof(ExrLayerOut) == 24, "ExrLayerOut layout");

struct ExrMultiResult {
    int          canvasWidth;   // 0
    int          canvasHeight;  // 4
    int          numLayers;     // 8
    int          layersPtr;     // 12  (ExrLayerOut* — array of numLayers entries)
};
static_assert(sizeof(ExrMultiResult) == 16, "ExrMultiResult layout");

// ─── Helpers ─────────────────────────────────────────────────────────────────

namespace {

// Split a channel name "Diffuse.R" into layer="Diffuse", suffix="R".
// "R" alone → layer="", suffix="R".
// "Foo.Bar.R" → layer="Foo.Bar", suffix="R".
void splitChannelName(const char* name, std::string& layer, std::string& suffix) {
    std::string n(name);
    auto pos = n.find_last_of('.');
    if (pos == std::string::npos) {
        layer.clear();
        suffix = n;
    } else {
        layer = n.substr(0, pos);
        suffix = n.substr(pos + 1);
    }
}

int suffixToRgbaIndex(const std::string& s) {
    if (s.size() != 1) return -1;
    char c = (char)std::tolower((unsigned char)s[0]);
    switch (c) {
        case 'r': return 0;
        case 'g': return 1;
        case 'b': return 2;
        case 'a': return 3;
        case 'y': return 0; // luminance — treat as grey
        default:  return -1;
    }
}

// Read a channel from an EXRImage into a float buffer of length w*h.
// Handles HALF / FLOAT / UINT pixel types.
void readChannelToFloat(const EXRImage* image, const EXRHeader* header,
                        int channelIdx, std::vector<float>& out) {
    const int w = image->width, h = image->height;
    out.assign((size_t)w * (size_t)h, 0.0f);
    if (!image->images || !image->images[channelIdx]) return;
    const int pt = header->pixel_types[channelIdx];
    if (pt == TINYEXR_PIXELTYPE_FLOAT) {
        const float* src = reinterpret_cast<const float*>(image->images[channelIdx]);
        std::memcpy(out.data(), src, sizeof(float) * out.size());
    } else if (pt == TINYEXR_PIXELTYPE_HALF) {
        const unsigned short* src = reinterpret_cast<const unsigned short*>(image->images[channelIdx]);
        for (size_t i = 0; i < out.size(); i++) {
            tinyexr::FP16 h16; h16.u = src[i];
            tinyexr::FP32 f32 = tinyexr::half_to_float(h16);
            out[i] = f32.f;
        }
    } else if (pt == TINYEXR_PIXELTYPE_UINT) {
        const unsigned int* src = reinterpret_cast<const unsigned int*>(image->images[channelIdx]);
        for (size_t i = 0; i < out.size(); i++) out[i] = (float)src[i];
    }
}

// Build full-canvas RGBA float pixels from an EXRImage + channel-name grouping.
// Each output entry is one named "layer" (the part of the channel name before
// the last '.'), full-image-sized (width × height of this part).
struct DecodedLayer {
    std::string  name;
    int          width;
    int          height;
    int          offsetX;
    int          offsetY;
    std::vector<float> pixels;  // RGBA float32, width*height*4
};

void decodePartIntoLayers(const EXRImage* image, const EXRHeader* header,
                          int partOffsetX, int partOffsetY,
                          const std::string& partNamePrefix,
                          std::vector<DecodedLayer>& outLayers) {
    const int w = image->width, h = image->height;

    // Group channel indices by layer name.  For each name, track the channel
    // index for each of R/G/B/A (-1 if absent).  Preserve insertion order via
    // a parallel vector of layer names so output ordering matches the file.
    std::vector<std::string> orderedNames;
    std::map<std::string, std::array<int,4>> g;
    for (int c = 0; c < header->num_channels; c++) {
        std::string lname, suffix;
        splitChannelName(header->channels[c].name, lname, suffix);
        int idx = suffixToRgbaIndex(suffix);
        if (idx < 0) continue;
        auto it = g.find(lname);
        if (it == g.end()) {
            std::array<int,4> a = { -1, -1, -1, -1 };
            it = g.emplace(lname, a).first;
            orderedNames.push_back(lname);
        }
        if (it->second[idx] < 0) it->second[idx] = c;
    }

    std::vector<float> chR, chG, chB, chA;

    for (const std::string& lname : orderedNames) {
        const auto& chans = g[lname];
        DecodedLayer layer;
        layer.width = w;
        layer.height = h;
        layer.offsetX = partOffsetX;
        layer.offsetY = partOffsetY;
        if (!partNamePrefix.empty() && !lname.empty()) {
            layer.name = partNamePrefix + "." + lname;
        } else if (!partNamePrefix.empty()) {
            layer.name = partNamePrefix;
        } else {
            layer.name = lname;
        }
        layer.pixels.assign((size_t)w * (size_t)h * 4, 0.0f);

        // Read each present channel.  For grey (Y-only / R-only / no channels),
        // duplicate.  Alpha defaults to 1.0.
        if (chans[0] >= 0) readChannelToFloat(image, header, chans[0], chR); else chR.clear();
        if (chans[1] >= 0) readChannelToFloat(image, header, chans[1], chG); else chG.clear();
        if (chans[2] >= 0) readChannelToFloat(image, header, chans[2], chB); else chB.clear();
        if (chans[3] >= 0) readChannelToFloat(image, header, chans[3], chA); else chA.clear();

        const bool hasR = !chR.empty();
        const bool hasG = !chG.empty();
        const bool hasB = !chB.empty();
        const bool hasA = !chA.empty();

        for (int i = 0; i < w * h; i++) {
            float r = hasR ? chR[i] : 0.0f;
            float gv = hasG ? chG[i] : (hasR ? r : 0.0f);
            float b = hasB ? chB[i] : (hasR ? r : 0.0f);
            float a = hasA ? chA[i] : 1.0f;
            layer.pixels[i * 4 + 0] = r;
            layer.pixels[i * 4 + 1] = gv;
            layer.pixels[i * 4 + 2] = b;
            layer.pixels[i * 4 + 3] = a;
        }
        outLayers.push_back(std::move(layer));
    }
}

ExrMultiResult* buildMultiResult(int canvasW, int canvasH,
                                 std::vector<DecodedLayer>&& layers) {
    auto* result = new ExrMultiResult();
    result->canvasWidth  = canvasW;
    result->canvasHeight = canvasH;
    result->numLayers    = (int)layers.size();
    result->layersPtr    = 0;
    if (layers.empty()) return result;

    auto* layerArr = (ExrLayerOut*)std::malloc(sizeof(ExrLayerOut) * layers.size());
    for (size_t i = 0; i < layers.size(); i++) {
        DecodedLayer& L = layers[i];
        const size_t pxBytes = sizeof(float) * L.pixels.size();
        float* pxBuf = (float*)std::malloc(pxBytes);
        std::memcpy(pxBuf, L.pixels.data(), pxBytes);

        const size_t nameLen = L.name.size();
        char* nameBuf = (char*)std::malloc(nameLen + 1);
        std::memcpy(nameBuf, L.name.data(), nameLen);
        nameBuf[nameLen] = '\0';

        layerArr[i].width     = L.width;
        layerArr[i].height    = L.height;
        layerArr[i].offsetX   = L.offsetX;
        layerArr[i].offsetY   = L.offsetY;
        layerArr[i].namePtr   = (int)(uintptr_t)nameBuf;
        layerArr[i].pixelsPtr = (int)(uintptr_t)pxBuf;
    }
    result->layersPtr = (int)(uintptr_t)layerArr;
    return result;
}

} // namespace

extern "C" {

// ─── Decode (single image, RGBA composite — backwards compat) ────────────────

EMSCRIPTEN_KEEPALIVE
ExrResult* loadExr(const unsigned char* src, int srcLen) {
    float* out   = nullptr;
    int    width = 0, height = 0;
    const char* err = nullptr;

    int ret = LoadEXRFromMemory(&out, &width, &height, src, (size_t)srcLen, &err);
    if (ret != TINYEXR_SUCCESS) {
        if (err) FreeEXRErrorMessage(err);
        return nullptr;
    }
    return new ExrResult{ width, height, out };
}

EMSCRIPTEN_KEEPALIVE
void freeExrResult(ExrResult* r) {
    if (!r) return;
    free(r->pixels);
    delete r;
}

// ─── Decode (multi-layer) ────────────────────────────────────────────────────

/**
 * Decode an EXR file into one-or-more named layers.
 * Returns pointer to ExrMultiResult, or 0 on failure.
 * Free with freeExrLayersResult.
 */
EMSCRIPTEN_KEEPALIVE
ExrMultiResult* loadExrLayers(const unsigned char* src, int srcLen) {
    EXRVersion version;
    int ret = ParseEXRVersionFromMemory(&version, src, (size_t)srcLen);
    if (ret != 0) return nullptr;

    std::vector<DecodedLayer> layers;
    int canvasW = 0, canvasH = 0;

    if (version.multipart) {
        EXRHeader** headers = nullptr;
        int numHeaders = 0;
        const char* err = nullptr;
        ret = ParseEXRMultipartHeaderFromMemory(&headers, &numHeaders, &version,
                                                src, (size_t)srcLen, &err);
        if (ret != 0 || numHeaders <= 0) {
            if (err) FreeEXRErrorMessage(err);
            return nullptr;
        }
        // Force float output for every channel of every part.
        for (int p = 0; p < numHeaders; p++) {
            for (int c = 0; c < headers[p]->num_channels; c++) {
                if (headers[p]->pixel_types[c] == TINYEXR_PIXELTYPE_HALF) {
                    headers[p]->requested_pixel_types[c] = TINYEXR_PIXELTYPE_FLOAT;
                }
            }
        }

        std::vector<EXRImage> images(numHeaders);
        for (int p = 0; p < numHeaders; p++) InitEXRImage(&images[p]);

        std::vector<const EXRHeader*> cheaders(numHeaders);
        for (int p = 0; p < numHeaders; p++) cheaders[p] = headers[p];

        ret = LoadEXRMultipartImageFromMemory(images.data(), cheaders.data(),
                                              (unsigned)numHeaders, src,
                                              (size_t)srcLen, &err);
        if (ret != 0) {
            if (err) FreeEXRErrorMessage(err);
            for (int p = 0; p < numHeaders; p++) {
                FreeEXRHeader(headers[p]);
                free(headers[p]);
            }
            free(headers);
            return nullptr;
        }

        // Canvas size = union of all parts' display windows; use the first part's
        // display window as authoritative (per EXR spec: same across multipart).
        const auto& dw = headers[0]->display_window;
        canvasW = dw.max_x - dw.min_x + 1;
        canvasH = dw.max_y - dw.min_y + 1;

        for (int p = 0; p < numHeaders; p++) {
            const auto& dataw = headers[p]->data_window;
            int offX = dataw.min_x - dw.min_x;
            int offY = dataw.min_y - dw.min_y;
            std::string partName = headers[p]->name;
            decodePartIntoLayers(&images[p], headers[p], offX, offY, partName, layers);
        }

        for (int p = 0; p < numHeaders; p++) {
            FreeEXRImage(&images[p]);
            FreeEXRHeader(headers[p]);
            free(headers[p]);
        }
        free(headers);
    } else {
        EXRHeader header;
        InitEXRHeader(&header);
        const char* err = nullptr;
        ret = ParseEXRHeaderFromMemory(&header, &version, src, (size_t)srcLen, &err);
        if (ret != 0) {
            if (err) FreeEXRErrorMessage(err);
            return nullptr;
        }
        for (int c = 0; c < header.num_channels; c++) {
            if (header.pixel_types[c] == TINYEXR_PIXELTYPE_HALF) {
                header.requested_pixel_types[c] = TINYEXR_PIXELTYPE_FLOAT;
            }
        }
        EXRImage image;
        InitEXRImage(&image);
        ret = LoadEXRImageFromMemory(&image, &header, src, (size_t)srcLen, &err);
        if (ret != 0) {
            if (err) FreeEXRErrorMessage(err);
            FreeEXRHeader(&header);
            return nullptr;
        }
        const auto& dw = header.display_window;
        const auto& dataw = header.data_window;
        canvasW = dw.max_x - dw.min_x + 1;
        canvasH = dw.max_y - dw.min_y + 1;
        int offX = dataw.min_x - dw.min_x;
        int offY = dataw.min_y - dw.min_y;
        decodePartIntoLayers(&image, &header, offX, offY, std::string(), layers);
        FreeEXRImage(&image);
        FreeEXRHeader(&header);
    }

    if (canvasW <= 0 || canvasH <= 0) {
        // Fallback: derive canvas from first layer.
        if (!layers.empty()) {
            canvasW = layers[0].width;
            canvasH = layers[0].height;
        } else {
            return nullptr;
        }
    }

    return buildMultiResult(canvasW, canvasH, std::move(layers));
}

EMSCRIPTEN_KEEPALIVE
void freeExrLayersResult(ExrMultiResult* r) {
    if (!r) return;
    if (r->layersPtr) {
        auto* arr = (ExrLayerOut*)(uintptr_t)r->layersPtr;
        for (int i = 0; i < r->numLayers; i++) {
            if (arr[i].namePtr)   free((void*)(uintptr_t)arr[i].namePtr);
            if (arr[i].pixelsPtr) free((void*)(uintptr_t)arr[i].pixelsPtr);
        }
        free(arr);
    }
    delete r;
}

// ─── Encode (single image) ────────────────────────────────────────────────────

EMSCRIPTEN_KEEPALIVE
ExrBytes* saveExr(const float* pixels, int width, int height, int compression, int halfFloat) {
    EXRHeader  header;
    EXRImage   image;
    InitEXRHeader(&header);
    InitEXRImage(&image);

    image.num_channels = 4;
    image.width        = width;
    image.height       = height;

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

    size_t outSize = SaveEXRImageToMemory(&image, &header, &outBuf, &err);

    delete[] header.channels;
    delete[] header.pixel_types;
    delete[] header.requested_pixel_types;

    if (outSize == 0 || outBuf == nullptr) {
        if (err) FreeEXRErrorMessage(err);
        return nullptr;
    }

    return new ExrBytes{ outBuf, static_cast<int>(outSize) };
}

EMSCRIPTEN_KEEPALIVE
void freeExrBytes(ExrBytes* b) {
    if (!b) return;
    free(b->data);
    delete b;
}

// ─── Encode (multi-layer, single-part, channel-named) ────────────────────────

/**
 * Save a multi-layer EXR.  Single-part file with channels named
 * "<LayerName>.R/G/B/A" (or just "R/G/B/A" if a layer name is empty).
 *
 * Inputs (all caller-allocated in WASM heap):
 *   width, height        Full canvas size (every layer must be this size).
 *   numLayers            Number of layers.
 *   concatNames          Null-separated layer names, exactly `numLayers`
 *                        null-terminated UTF-8 strings concatenated.
 *   concatPixels         numLayers × width*height*4 floats, layer-major.
 *   compression          0=none, 1=zip, 2=zips, 3=piz
 *   halfFloat            0 = float32, 1 = half16
 *
 * Returns ExrBytes* (free with freeExrBytes), or 0 on error.
 */
EMSCRIPTEN_KEEPALIVE
ExrBytes* saveExrLayers(int width, int height, int numLayers,
                        const char* concatNames, const float* concatPixels,
                        int compression, int halfFloat) {
    if (numLayers <= 0 || width <= 0 || height <= 0) return nullptr;

    // Parse concatenated names.
    std::vector<std::string> names;
    names.reserve(numLayers);
    {
        const char* p = concatNames;
        for (int i = 0; i < numLayers; i++) {
            std::string s(p);
            names.push_back(std::move(s));
            p += names.back().size() + 1;
        }
    }

    // Sanitize names: empty → "Layer<N>"; ensure uniqueness.
    {
        std::map<std::string, int> seen;
        for (int i = 0; i < numLayers; i++) {
            if (names[i].empty()) {
                char buf[32]; snprintf(buf, sizeof(buf), "Layer%d", i);
                names[i] = buf;
            }
            // Replace any '.' in the layer name to avoid clashing with the
            // channel-name separator.
            for (auto& c : names[i]) if (c == '.') c = '_';
            std::string base = names[i];
            int n = 1;
            while (seen.count(names[i])) {
                char buf[32]; snprintf(buf, sizeof(buf), "_%d", n++);
                names[i] = base + buf;
            }
            seen[names[i]] = 1;
        }
    }

    const int pixelsPerLayer = width * height;
    const int totalChannels  = numLayers * 4;

    // Per-channel float buffers (planar, EXR convention).
    std::vector<std::vector<float>> channels(totalChannels);
    for (int li = 0; li < numLayers; li++) {
        const float* src = concatPixels + (size_t)li * pixelsPerLayer * 4;
        // Channels written in alphabetical order within each layer (A,B,G,R).
        std::vector<float>& A = channels[li * 4 + 0];
        std::vector<float>& B = channels[li * 4 + 1];
        std::vector<float>& G = channels[li * 4 + 2];
        std::vector<float>& R = channels[li * 4 + 3];
        A.resize(pixelsPerLayer);
        B.resize(pixelsPerLayer);
        G.resize(pixelsPerLayer);
        R.resize(pixelsPerLayer);
        for (int i = 0; i < pixelsPerLayer; i++) {
            R[i] = src[i * 4 + 0];
            G[i] = src[i * 4 + 1];
            B[i] = src[i * 4 + 2];
            A[i] = src[i * 4 + 3];
        }
    }

    // image.images is an array of channel pointers.
    std::vector<unsigned char*> imagePtrs(totalChannels);
    for (int c = 0; c < totalChannels; c++) {
        imagePtrs[c] = reinterpret_cast<unsigned char*>(channels[c].data());
    }

    EXRImage image;
    InitEXRImage(&image);
    image.num_channels = totalChannels;
    image.width        = width;
    image.height       = height;
    image.images       = imagePtrs.data();

    EXRHeader header;
    InitEXRHeader(&header);
    header.num_channels = totalChannels;
    header.channels     = new EXRChannelInfo[totalChannels];
    header.pixel_types           = new int[totalChannels];
    header.requested_pixel_types = new int[totalChannels];

    const int pixType = halfFloat ? TINYEXR_PIXELTYPE_HALF : TINYEXR_PIXELTYPE_FLOAT;
    static const char* suffixes[4] = { "A", "B", "G", "R" };
    for (int li = 0; li < numLayers; li++) {
        for (int s = 0; s < 4; s++) {
            int c = li * 4 + s;
            std::string fullName = names[li] + "." + suffixes[s];
            strncpy(header.channels[c].name, fullName.c_str(), 255);
            header.channels[c].name[255] = '\0';
            header.pixel_types[c]           = TINYEXR_PIXELTYPE_FLOAT;
            header.requested_pixel_types[c] = pixType;
        }
    }

    int compressionType = TINYEXR_COMPRESSIONTYPE_NONE;
    switch (compression) {
        case 1: compressionType = TINYEXR_COMPRESSIONTYPE_ZIP;  break;
        case 2: compressionType = TINYEXR_COMPRESSIONTYPE_ZIPS; break;
        case 3: compressionType = TINYEXR_COMPRESSIONTYPE_PIZ;  break;
        default: break;
    }
    header.compression_type = compressionType;

    unsigned char* outBuf = nullptr;
    const char*    err    = nullptr;
    size_t outSize = SaveEXRImageToMemory(&image, &header, &outBuf, &err);

    delete[] header.channels;
    delete[] header.pixel_types;
    delete[] header.requested_pixel_types;

    if (outSize == 0 || outBuf == nullptr) {
        if (err) FreeEXRErrorMessage(err);
        return nullptr;
    }
    return new ExrBytes{ outBuf, static_cast<int>(outSize) };
}

} // extern "C"
