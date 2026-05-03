// dds.h — DDS (DirectDraw Surface) encode/decode API
//
// Supports:
//   Decode: BC1, BC2, BC3, BC4, BC5, BC6H (→ float32), BC7, RGBA8 uncompressed, RGBA32F uncompressed
//   Encode: BC1, BC3, BC7 (from RGBA8), BC6H UF16 / RGBA32F (from float32 RGBA)
//
// Format codes (DdsFormat enum values):
//   1 = BC1, 2 = BC2, 3 = BC3, 4 = BC4, 5 = BC5
//   6 = BC6H, 7 = BC7, 8 = RGBA8 uncompressed, 9 = RGBA32F uncompressed
//
// Return values from all functions:
//   DDS_OK (0)           = success
//   DDS_ERR_INVALID (-1) = malformed / truncated data
//   DDS_ERR_UNSUPPORTED (-2) = known format but not implemented
//   DDS_ERR_MEMORY (-3)  = allocation failed / output buffer too small

#pragma once
#include <stdint.h>

// ── Error codes ───────────────────────────────────────────────────────────────

#define DDS_OK           0
#define DDS_ERR_INVALID  (-1)
#define DDS_ERR_UNSUPPORTED (-2)
#define DDS_ERR_MEMORY   (-3)

// ── Format identifiers ────────────────────────────────────────────────────────

#define DDS_FMT_BC1    1
#define DDS_FMT_BC2    2
#define DDS_FMT_BC3    3
#define DDS_FMT_BC4    4
#define DDS_FMT_BC5    5
#define DDS_FMT_BC6H   6
#define DDS_FMT_BC7    7
#define DDS_FMT_RGBA8  8
#define DDS_FMT_RGBA32F 9

// ── Header mode for encode ────────────────────────────────────────────────────

// DDS_HEADER_AUTO: encoder chooses (DX10 for BC6H, BC7, RGBA32F; DX9 otherwise)
// DDS_HEADER_DX9:  legacy header (supported for BC1-5 only)
// DDS_HEADER_DX10: modern DX10 header with DXGI format field
#define DDS_HEADER_AUTO 0
#define DDS_HEADER_DX9  1
#define DDS_HEADER_DX10 2

// ── Info struct ───────────────────────────────────────────────────────────────

struct dds_info {
    int32_t width;
    int32_t height;
    int32_t fmt;        // one of DDS_FMT_* above
    int32_t mipLevels;  // >= 1
};

#ifdef __cplusplus
extern "C" {
#endif

// ── API ───────────────────────────────────────────────────────────────────────

// Parse DDS header and fill *out without decoding any pixels.
// Returns DDS_OK or an error code.
int dds_get_info(const uint8_t *data, int32_t size, dds_info *out);

// Decode DDS to RGBA8 pixels.  BC6H HDR values are tone-mapped (Reinhard).
// out must be width*height*4 bytes.  Returns DDS_OK or error.
int dds_decode(const uint8_t *data, int32_t size,
               uint8_t *out, int32_t outSize);

// Decode DDS to RGBA float32 pixels.  BC1-5 channels are normalised [0,1].
// BC6H channels preserve HDR values.  out must be width*height*16 bytes.
// Returns DDS_OK or error.
int dds_decode_f32(const uint8_t *data, int32_t size,
                   float *out, int32_t outSize);

// Return the byte size of the output buffer needed for dds_encode / dds_encode_f32.
// mipLevels >= 1; pass 1 to encode only the base level.
// Does NOT encode.  Returns DDS_ERR_INVALID if the parameters are invalid.
int32_t dds_get_encoded_size(int32_t width, int32_t height,
                             int fmt, int mipLevels, int headerMode);

// Maximum mip levels such that the smallest dimension is >= minDim.
// minDim must be > 0. Returns at least 1.
int dds_max_mip_levels(int32_t width, int32_t height, int minDim);

// Encode RGBA8 pixels to DDS.  fmt must be DDS_FMT_BC1, BC3, or BC7.
// mipLevels >= 1; additional levels are generated via box-filter downscale.
// out must be at least dds_get_encoded_size() bytes.
// Returns DDS_OK or error.
int dds_encode(const uint8_t *pixels, int32_t width, int32_t height,
               int fmt, int mipLevels, int headerMode,
               uint8_t *out, int32_t outSize);

// Encode RGBA float32 pixels to DDS.  fmt must be DDS_FMT_BC6H or DDS_FMT_RGBA32F.
// Header mode is always DX10 for these formats (headerMode param is ignored).
// mipLevels >= 1; additional levels are generated via box-filter downscale.
// out must be at least dds_get_encoded_size() bytes.
// Returns DDS_OK or error.
int dds_encode_f32(const float *pixels, int32_t width, int32_t height,
                   int fmt, int mipLevels, int headerMode,
                   uint8_t *out, int32_t outSize);

#ifdef __cplusplus
} // extern "C"
#endif
