// dds.cpp — DDS encode/decode implementation
//
// Decode:  bcdec (BC1-BC7, BC6H)        — MIT/Unlicense
// Encode BC1-5: rgbcx                   — MIT/Public Domain
// Encode BC7:   bc7enc                  — MIT/Public Domain
// Encode BC6H:  minimal mode-11 encoder — see bc6h_encode_block() below

#define BCDEC_IMPLEMENTATION
#include "vendor/bcdec.h"

#define RGBCX_IMPLEMENTATION
#include "vendor/rgbcx.h"

#include "vendor/bc7enc.h"

#include "dds.h"

#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#include <algorithm>

// ── DDS file format constants ─────────────────────────────────────────────────

static const uint32_t DDS_MAGIC       = 0x20534444u; // "DDS "
static const uint32_t DDSD_CAPS       = 0x00000001u;
static const uint32_t DDSD_HEIGHT     = 0x00000002u;
static const uint32_t DDSD_WIDTH      = 0x00000004u;
static const uint32_t DDSD_PIXELFORMAT = 0x00001000u;
static const uint32_t DDSD_LINEARSIZE = 0x00080000u;
static const uint32_t DDSD_PITCH      = 0x00000008u;

static const uint32_t DDSCAPS_TEXTURE = 0x00001000u;

static const uint32_t DDPF_FOURCC     = 0x00000004u;
static const uint32_t DDPF_RGB        = 0x00000040u;
static const uint32_t DDPF_ALPHAPIXELS = 0x00000001u;
static const uint32_t DDSD_MIPMAPCOUNT = 0x00020000u;
static const uint32_t DDSCAPS_MIPMAP   = 0x00400000u;
static const uint32_t DDSCAPS_COMPLEX  = 0x00000008u;

static const uint32_t DDS_DX10_FOURCC = 0x30315844u; // "DX10"

// DXGI format codes
static const uint32_t DXGI_FORMAT_R32G32B32A32_FLOAT = 2u;
static const uint32_t DXGI_FORMAT_R8G8B8A8_UNORM     = 28u;
static const uint32_t DXGI_FORMAT_BC1_UNORM           = 71u;
static const uint32_t DXGI_FORMAT_BC2_UNORM           = 74u;
static const uint32_t DXGI_FORMAT_BC3_UNORM           = 77u;
static const uint32_t DXGI_FORMAT_BC4_UNORM           = 80u;
static const uint32_t DXGI_FORMAT_BC5_UNORM           = 83u;
static const uint32_t DXGI_FORMAT_BC6H_UF16           = 95u;
static const uint32_t DXGI_FORMAT_BC7_UNORM           = 98u;

static const uint32_t D3D10_RESOURCE_DIMENSION_TEXTURE2D = 3u;

// FourCC helpers
static uint32_t make_fourcc(char a, char b, char c, char d) {
    return (uint32_t)a | ((uint32_t)b << 8) | ((uint32_t)c << 16) | ((uint32_t)d << 24);
}

// ── DDS header layout (packed structs) ────────────────────────────────────────

#pragma pack(push, 1)
struct DdsPixelFormat {
    uint32_t dwSize;
    uint32_t dwFlags;
    uint32_t dwFourCC;
    uint32_t dwRGBBitCount;
    uint32_t dwRBitMask;
    uint32_t dwGBitMask;
    uint32_t dwBBitMask;
    uint32_t dwABitMask;
};

struct DdsHeader {
    uint32_t dwMagic;
    uint32_t dwSize;
    uint32_t dwFlags;
    uint32_t dwHeight;
    uint32_t dwWidth;
    uint32_t dwPitchOrLinearSize;
    uint32_t dwDepth;
    uint32_t dwMipMapCount;
    uint32_t dwReserved1[11];
    DdsPixelFormat ddpf;
    uint32_t dwCaps;
    uint32_t dwCaps2;
    uint32_t dwCaps3;
    uint32_t dwCaps4;
    uint32_t dwReserved2;
};

struct DdsHeaderDXT10 {
    uint32_t dxgiFormat;
    uint32_t resourceDimension;
    uint32_t miscFlag;
    uint32_t arraySize;
    uint32_t miscFlags2;
};
#pragma pack(pop)

static const uint32_t DDS_HEADER_SIZE = sizeof(DdsHeader); // 128 bytes (includes magic)
static const uint32_t DXT10_EXT_SIZE  = sizeof(DdsHeaderDXT10); // 20 bytes

// ── Utility ───────────────────────────────────────────────────────────────────

static inline uint32_t read_u32(const uint8_t *p) {
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static inline void write_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v);
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static inline int blocks_in_dim(int dim) {
    return (dim + 3) / 4;
}

// Compressed bytes per 4×4 block
static int bytes_per_block(int fmt) {
    switch (fmt) {
    case DDS_FMT_BC1: case DDS_FMT_BC4: return 8;
    case DDS_FMT_BC2: case DDS_FMT_BC3: case DDS_FMT_BC5:
    case DDS_FMT_BC6H: case DDS_FMT_BC7:                 return 16;
    default: return -1;
    }
}

// ── float ↔ half-float helpers (for BC6H) ─────────────────────────────────────

// Convert single-precision float to IEEE 754 half-float (unsigned, clamp negatives to 0).
static uint16_t f32_to_uf16(float f) {
    if (f <= 0.0f) return 0;
    if (f >= 65504.0f) return 0x7BFF; // max finite uf16
    uint32_t bits;
    memcpy(&bits, &f, 4);
    uint32_t sign   = bits >> 31;
    (void)sign; // unsigned — ignore
    uint32_t exp    = (bits >> 23) & 0xFF;
    uint32_t mant   = bits & 0x7FFFFF;
    if (exp == 255) return 0x7C00; // inf/NaN → uf16 inf
    int halfExp = (int)exp - 127 + 15;
    if (halfExp <= 0) {
        // Denormal or underflow
        if (halfExp < -10) return 0;
        mant = (mant | 0x800000) >> (1 - halfExp);
        return (uint16_t)(mant >> 13);
    }
    if (halfExp >= 31) return 0x7BFF; // overflow
    return (uint16_t)(((halfExp) << 10) | (mant >> 13));
}

// Convert unsigned half-float to float
static float uf16_to_f32(uint16_t h) {
    uint32_t exp  = (h >> 10) & 0x1F;
    uint32_t mant = h & 0x3FF;
    float result;
    if (exp == 0) {
        result = ldexpf((float)mant, -24);
    } else if (exp == 31) {
        result = INFINITY;
    } else {
        uint32_t bits = ((exp + (127u - 15u)) << 23) | (mant << 13);
        memcpy(&result, &bits, 4);
    }
    return result;
}

// Map a 16-bit unsigned half-float integer to the 10-bit BC6H mode-11 endpoint value.
// Based on: half ≈ val * 31 + 15  (from bcdec's unquantize + finish_unquantize for UF16).
// Inverse: val = round(half / 31) but with special cases.
static uint16_t uf16_to_mode11_val(uint16_t h) {
    if (h == 0) return 0;
    if (h >= 0x7BFF) return 1023; // special: decodes back to 0xFFFF → max
    // Approximate inverse: val = round((h - 15) / 31)
    int val = (int)(((int)h - 15 + 15) / 31); // = h / 31 approx
    if (val <= 0) val = 1;
    if (val >= 1023) val = 1022;
    return (uint16_t)val;
}

// Decode a BC6H mode-11 10-bit endpoint value back to a 16-bit unsigned half.
static uint16_t mode11_val_to_uf16(uint16_t val) {
    // bcdec bcdec__unquantize for UF16, 10-bit:
    uint16_t unq;
    if (val == 0) { unq = 0; }
    else if (val == 1023) { unq = 0xFFFF; }
    else { unq = (uint16_t)(((uint32_t)(val) * 64u + 32u)); }
    // bcdec bcdec__finish_unquantize for unsigned:
    return (uint16_t)(((uint32_t)unq * 31u) >> 6u);
}

// ── BC6H mode-11 block encoder ────────────────────────────────────────────────
//
// Mode 11 (0b00011): single region, 2 explicit endpoints, 4-bit indices.
// Each endpoint stores R0,G0,B0 and R1,G1,B1 as 10-bit unsigned values.
// Bit layout (128 bits total, LSB first):
//   bits 4:0   = 0b00011 (mode)
//   bits 14:5  = r0[9:0]
//   bits 24:15 = g0[9:0]
//   bits 34:25 = b0[9:0]
//   bits 44:35 = r1[9:0]
//   bits 54:45 = g1[9:0]
//   bits 64:55 = b1[9:0]
//   bits 127:65 = 16 indices (first index 3 bits with MSB=0, rest 4 bits each)
//                 Weight table: {0,4,9,13,17,21,26,30,34,38,43,47,51,55,60,64} / 64

static const int k_bc6h_w4[16] = { 0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64 };

// Pack bits into a 16-byte block (LSB first).
struct BitWriter {
    uint8_t data[16];
    int bit_pos;
    void reset() { memset(data, 0, 16); bit_pos = 0; }
    void write(uint32_t value, int nbits) {
        for (int i = 0; i < nbits; i++) {
            int byte = bit_pos >> 3;
            int bit  = bit_pos & 7;
            data[byte] |= (uint8_t)(((value >> i) & 1) << bit);
            bit_pos++;
        }
    }
};

static void bc6h_encode_block(
    const float *block_rgba,  // 16 pixels × 4 floats (RGB, A ignored)
    uint8_t *out16            // 16-byte output block
) {
    // 1. Convert float RGB to unsigned half-float
    uint16_t hr[16], hg[16], hb[16];
    for (int i = 0; i < 16; i++) {
        const float *p = block_rgba + i * 4;
        hr[i] = f32_to_uf16(p[0]);
        hg[i] = f32_to_uf16(p[1]);
        hb[i] = f32_to_uf16(p[2]);
    }

    // 2. Find endpoints (min/max per channel)
    uint16_t minR = hr[0], maxR = hr[0];
    uint16_t minG = hg[0], maxG = hg[0];
    uint16_t minB = hb[0], maxB = hb[0];
    for (int i = 1; i < 16; i++) {
        if (hr[i] < minR) minR = hr[i];
        if (hr[i] > maxR) maxR = hr[i];
        if (hg[i] < minG) minG = hg[i];
        if (hg[i] > maxG) maxG = hg[i];
        if (hb[i] < minB) minB = hb[i];
        if (hb[i] > maxB) maxB = hb[i];
    }

    // 3. Convert endpoints to 10-bit mode-11 values
    uint16_t r0 = uf16_to_mode11_val(minR), r1 = uf16_to_mode11_val(maxR);
    uint16_t g0 = uf16_to_mode11_val(minG), g1 = uf16_to_mode11_val(maxG);
    uint16_t b0 = uf16_to_mode11_val(minB), b1 = uf16_to_mode11_val(maxB);

    // 4. Decode endpoints back to half-float for index search
    float er0 = uf16_to_f32(mode11_val_to_uf16(r0));
    float er1 = uf16_to_f32(mode11_val_to_uf16(r1));
    float eg0 = uf16_to_f32(mode11_val_to_uf16(g0));
    float eg1 = uf16_to_f32(mode11_val_to_uf16(g1));
    float eb0 = uf16_to_f32(mode11_val_to_uf16(b0));
    float eb1 = uf16_to_f32(mode11_val_to_uf16(b1));

    // 5. For each pixel, find the best index
    uint8_t indices[16];
    float lenSq = (er1 - er0) * (er1 - er0)
                + (eg1 - eg0) * (eg1 - eg0)
                + (eb1 - eb0) * (eb1 - eb0);

    for (int i = 0; i < 16; i++) {
        float pr = uf16_to_f32(hr[i]);
        float pg = uf16_to_f32(hg[i]);
        float pb = uf16_to_f32(hb[i]);

        float best_t = 0.0f;
        if (lenSq > 0.0f) {
            best_t = ((pr - er0) * (er1 - er0)
                    + (pg - eg0) * (eg1 - eg0)
                    + (pb - eb0) * (eb1 - eb0)) / lenSq;
            best_t = best_t < 0.0f ? 0.0f : (best_t > 1.0f ? 1.0f : best_t);
        }

        // Find nearest weight index
        int best_idx = 0;
        float best_err = 1e30f;
        for (int j = 0; j < 16; j++) {
            float wt = k_bc6h_w4[j] / 64.0f;
            float diff = wt - best_t;
            float err = diff * diff;
            if (err < best_err) { best_err = err; best_idx = j; }
        }
        indices[i] = (uint8_t)best_idx;
    }

    // 6. Fix up index 0: MSB must be 0 (convention); if not, swap endpoints + invert indices
    if (indices[0] >= 8) {
        // Swap endpoints
        uint16_t tmp;
        tmp = r0; r0 = r1; r1 = tmp;
        tmp = g0; g0 = g1; g1 = tmp;
        tmp = b0; b0 = b1; b1 = tmp;
        for (int i = 0; i < 16; i++) {
            indices[i] = (uint8_t)(15 - indices[i]);
        }
    }

    // 7. Pack into 128-bit block
    BitWriter bw;
    bw.reset();
    bw.write(0b00011, 5);  // mode 11
    bw.write(r0, 10);
    bw.write(g0, 10);
    bw.write(b0, 10);
    bw.write(r1, 10);
    bw.write(g1, 10);
    bw.write(b1, 10);
    // Index 0: 3 bits (MSB suppressed, so write bits [2:0])
    bw.write(indices[0] & 0x7, 3);
    // Indices 1-15: 4 bits each
    for (int i = 1; i < 16; i++) {
        bw.write(indices[i] & 0xF, 4);
    }
    memcpy(out16, bw.data, 16);
}

// ── DDS header parsing helpers ─────────────────────────────────────────────────

// Returns the DDS_FMT_* for a given DX10 DXGI format, or 0 if unsupported
static int dxgi_to_fmt(uint32_t dxgi) {
    switch (dxgi) {
    case DXGI_FORMAT_BC1_UNORM:           return DDS_FMT_BC1;
    case DXGI_FORMAT_BC2_UNORM:           return DDS_FMT_BC2;
    case DXGI_FORMAT_BC3_UNORM:           return DDS_FMT_BC3;
    case DXGI_FORMAT_BC4_UNORM:           return DDS_FMT_BC4;
    case DXGI_FORMAT_BC5_UNORM:           return DDS_FMT_BC5;
    case DXGI_FORMAT_BC6H_UF16:           return DDS_FMT_BC6H;
    case DXGI_FORMAT_BC7_UNORM:           return DDS_FMT_BC7;
    case DXGI_FORMAT_R8G8B8A8_UNORM:      return DDS_FMT_RGBA8;
    case DXGI_FORMAT_R32G32B32A32_FLOAT:  return DDS_FMT_RGBA32F;
    default: return 0;
    }
}

// Returns DDS_FMT_* from a legacy DX9 FourCC, or 0 if unsupported
static int fourcc_to_fmt(uint32_t cc) {
    if (cc == make_fourcc('D','X','T','1')) return DDS_FMT_BC1;
    if (cc == make_fourcc('D','X','T','3')) return DDS_FMT_BC2;
    if (cc == make_fourcc('D','X','T','5')) return DDS_FMT_BC3;
    if (cc == make_fourcc('B','C','4','U')) return DDS_FMT_BC4;
    if (cc == make_fourcc('A','T','I','1')) return DDS_FMT_BC4;
    if (cc == make_fourcc('B','C','5','U')) return DDS_FMT_BC5;
    if (cc == make_fourcc('A','T','I','2')) return DDS_FMT_BC5;
    return 0;
}

// ── dds_get_info ─────────────────────────────────────────────────────────────

int dds_get_info(const uint8_t *data, int32_t size, dds_info *out) {
    if (!data || !out || size < (int32_t)DDS_HEADER_SIZE) return DDS_ERR_INVALID;

    if (read_u32(data) != DDS_MAGIC) return DDS_ERR_INVALID;

    uint32_t hdrSize = read_u32(data + 4);
    if (hdrSize != 124) return DDS_ERR_INVALID;

    int32_t height = (int32_t)read_u32(data + 12);
    int32_t width  = (int32_t)read_u32(data + 16);
    int32_t mipCount = (int32_t)read_u32(data + 28);
    if (mipCount < 1) mipCount = 1;

    // PixelFormat offset: magic(4) + size(4) + flags(4) + height(4) + width(4) + pitch(4)
    // + depth(4) + mipMapCount(4) + reserved[11](44) = 76 bytes before ddpf
    const uint8_t *ddpf = data + 76; // DDPIXELFORMAT starts at byte 76
    uint32_t ddpfFlags  = read_u32(ddpf + 4);
    uint32_t fourcc     = read_u32(ddpf + 8);

    int fmt = 0;

    if ((ddpfFlags & DDPF_FOURCC) && fourcc == DDS_DX10_FOURCC) {
        // DX10 extended header
        if (size < (int32_t)(DDS_HEADER_SIZE + DXT10_EXT_SIZE)) return DDS_ERR_INVALID;
        uint32_t dxgi = read_u32(data + DDS_HEADER_SIZE);
        fmt = dxgi_to_fmt(dxgi);
        if (fmt == 0) {
            // Check for BC6H_SF16 (signed)
            if (dxgi == 96u) fmt = DDS_FMT_BC6H; // DXGI_FORMAT_BC6H_SF16 → decode as BC6H
            else return DDS_ERR_UNSUPPORTED;
        }
    } else if (ddpfFlags & DDPF_FOURCC) {
        fmt = fourcc_to_fmt(fourcc);
        if (fmt == 0) return DDS_ERR_UNSUPPORTED;
    } else if (ddpfFlags & DDPF_RGB) {
        // Uncompressed RGB(A)
        uint32_t bpp = read_u32(ddpf + 12);
        if (bpp == 32) fmt = DDS_FMT_RGBA8;
        else return DDS_ERR_UNSUPPORTED;
    } else {
        return DDS_ERR_UNSUPPORTED;
    }

    out->width     = width;
    out->height    = height;
    out->fmt       = fmt;
    out->mipLevels = mipCount;
    return DDS_OK;
}

// ── Shared decode context ─────────────────────────────────────────────────────

struct DecodeCtx {
    const uint8_t *pixelData;
    int32_t pixelDataSize;
    int32_t width;
    int32_t height;
    int     fmt;
    int     isSigned; // for BC6H_SF16
};

static int parse_ctx(const uint8_t *data, int32_t size, DecodeCtx *ctx) {
    dds_info info;
    int err = dds_get_info(data, size, &info);
    if (err != DDS_OK) return err;

    int32_t headerBytes = (int32_t)DDS_HEADER_SIZE;
    uint32_t fourcc = read_u32(data + 84); // ddpf.dwFourCC
    ctx->isSigned = 0;
    if (fourcc == DDS_DX10_FOURCC) {
        headerBytes += (int32_t)DXT10_EXT_SIZE;
        uint32_t dxgi = read_u32(data + DDS_HEADER_SIZE);
        if (dxgi == 96u) ctx->isSigned = 1; // BC6H_SF16
    }

    ctx->pixelData     = data + headerBytes;
    ctx->pixelDataSize = size - headerBytes;
    ctx->width         = info.width;
    ctx->height        = info.height;
    ctx->fmt           = info.fmt;
    return DDS_OK;
}

// ── dds_decode ───────────────────────────────────────────────────────────────

int dds_decode(const uint8_t *data, int32_t size, uint8_t *out, int32_t outSize) {
    DecodeCtx ctx;
    int err = parse_ctx(data, size, &ctx);
    if (err != DDS_OK) return err;

    int32_t w = ctx.width, h = ctx.height;
    int32_t needed = w * h * 4;
    if (outSize < needed) return DDS_ERR_MEMORY;

    if (ctx.fmt == DDS_FMT_RGBA8) {
        if (ctx.pixelDataSize < needed) return DDS_ERR_INVALID;
        memcpy(out, ctx.pixelData, (size_t)needed);
        return DDS_OK;
    }

    if (ctx.fmt == DDS_FMT_RGBA32F) {
        // Tonemap float → RGBA8 (Reinhard per channel)
        int32_t floatNeeded = w * h * 16;
        if (ctx.pixelDataSize < floatNeeded) return DDS_ERR_INVALID;
        const float *src = (const float *)ctx.pixelData;
        for (int i = 0; i < w * h; i++) {
            float r = src[i*4], g = src[i*4+1], b = src[i*4+2], a = src[i*4+3];
            // Simple Reinhard tonemap
            r = r / (1.0f + r); g = g / (1.0f + g); b = b / (1.0f + b);
            // linear to sRGB (approx)
            r = sqrtf(r < 0.0f ? 0.0f : r);
            g = sqrtf(g < 0.0f ? 0.0f : g);
            b = sqrtf(b < 0.0f ? 0.0f : b);
            a = a < 0.0f ? 0.0f : (a > 1.0f ? 1.0f : a);
            out[i*4]   = (uint8_t)(r * 255.0f + 0.5f);
            out[i*4+1] = (uint8_t)(g * 255.0f + 0.5f);
            out[i*4+2] = (uint8_t)(b * 255.0f + 0.5f);
            out[i*4+3] = (uint8_t)(a * 255.0f + 0.5f);
        }
        return DDS_OK;
    }

    // BC block decode
    int bpb = bytes_per_block(ctx.fmt);
    if (bpb < 0) return DDS_ERR_UNSUPPORTED;

    int bx = blocks_in_dim(w), by = blocks_in_dim(h);
    int32_t compressedNeeded = bx * by * bpb;
    if (ctx.pixelDataSize < compressedNeeded) return DDS_ERR_INVALID;

    const uint8_t *src = ctx.pixelData;
    // Temp buffer for one 4×4 block output
    union { uint8_t rgba[64]; float frgb[16*3]; } blk;

    for (int by_i = 0; by_i < by; by_i++) {
        for (int bx_i = 0; bx_i < bx; bx_i++) {
            const uint8_t *block = src;
            src += bpb;

            memset(&blk, 0, sizeof(blk));
            int is6H = (ctx.fmt == DDS_FMT_BC6H);

            if (is6H) {
                // BC6H → float RGB (3 floats per pixel in 4×4 block)
                bcdec_bc6h_float(block, blk.frgb, 4*3, ctx.isSigned);
            } else {
                switch (ctx.fmt) {
                case DDS_FMT_BC1: bcdec_bc1(block, blk.rgba, 4*4); break;
                case DDS_FMT_BC2: bcdec_bc2(block, blk.rgba, 4*4); break;
                case DDS_FMT_BC3: bcdec_bc3(block, blk.rgba, 4*4); break;
                case DDS_FMT_BC4: bcdec_bc4(block, blk.rgba, 4*1); break;
                case DDS_FMT_BC5: bcdec_bc5(block, blk.rgba, 4*2); break;
                case DDS_FMT_BC7: bcdec_bc7(block, blk.rgba, 4*4); break;
                default: return DDS_ERR_UNSUPPORTED;
                }
            }

            // Scatter the 4×4 block into the output image
            for (int py = 0; py < 4; py++) {
                int iy = by_i * 4 + py;
                if (iy >= h) continue;
                for (int px = 0; px < 4; px++) {
                    int ix = bx_i * 4 + px;
                    if (ix >= w) continue;
                    int dst_off = (iy * w + ix) * 4;
                    if (is6H) {
                        float fr = blk.frgb[(py*4+px)*3+0];
                        float fg = blk.frgb[(py*4+px)*3+1];
                        float fb = blk.frgb[(py*4+px)*3+2];
                        // Reinhard tonemap + gamma approx
                        fr = sqrtf(fr / (1.0f + fr));
                        fg = sqrtf(fg / (1.0f + fg));
                        fb = sqrtf(fb / (1.0f + fb));
                        out[dst_off]   = (uint8_t)(fr < 0.0f ? 0 : fr > 1.0f ? 255 : (int)(fr * 255.0f + 0.5f));
                        out[dst_off+1] = (uint8_t)(fg < 0.0f ? 0 : fg > 1.0f ? 255 : (int)(fg * 255.0f + 0.5f));
                        out[dst_off+2] = (uint8_t)(fb < 0.0f ? 0 : fb > 1.0f ? 255 : (int)(fb * 255.0f + 0.5f));
                        out[dst_off+3] = 255;
                    } else if (ctx.fmt == DDS_FMT_BC4) {
                        uint8_t r = blk.rgba[(py*4+px)*1];
                        out[dst_off] = r; out[dst_off+1] = r; out[dst_off+2] = r; out[dst_off+3] = 255;
                    } else if (ctx.fmt == DDS_FMT_BC5) {
                        uint8_t r = blk.rgba[(py*4+px)*2+0];
                        uint8_t g = blk.rgba[(py*4+px)*2+1];
                        out[dst_off] = r; out[dst_off+1] = g; out[dst_off+2] = 0; out[dst_off+3] = 255;
                    } else {
                        memcpy(out + dst_off, blk.rgba + (py*4+px)*4, 4);
                    }
                }
            }
        }
    }
    return DDS_OK;
}

// ── dds_decode_f32 ───────────────────────────────────────────────────────────

int dds_decode_f32(const uint8_t *data, int32_t size, float *out, int32_t outSize) {
    DecodeCtx ctx;
    int err = parse_ctx(data, size, &ctx);
    if (err != DDS_OK) return err;

    int32_t w = ctx.width, h = ctx.height;
    int32_t needed = w * h * 16; // 4 floats per pixel
    if (outSize < needed) return DDS_ERR_MEMORY;

    if (ctx.fmt == DDS_FMT_RGBA32F) {
        if (ctx.pixelDataSize < needed) return DDS_ERR_INVALID;
        memcpy(out, ctx.pixelData, (size_t)needed);
        return DDS_OK;
    }

    if (ctx.fmt == DDS_FMT_RGBA8) {
        int32_t rgbaNeeded = w * h * 4;
        if (ctx.pixelDataSize < rgbaNeeded) return DDS_ERR_INVALID;
        const uint8_t *src8 = ctx.pixelData;
        for (int i = 0; i < w * h; i++) {
            out[i*4]   = src8[i*4]   / 255.0f;
            out[i*4+1] = src8[i*4+1] / 255.0f;
            out[i*4+2] = src8[i*4+2] / 255.0f;
            out[i*4+3] = src8[i*4+3] / 255.0f;
        }
        return DDS_OK;
    }

    int bpb = bytes_per_block(ctx.fmt);
    if (bpb < 0) return DDS_ERR_UNSUPPORTED;

    int bx = blocks_in_dim(w), by = blocks_in_dim(h);
    int32_t compressedNeeded = bx * by * bpb;
    if (ctx.pixelDataSize < compressedNeeded) return DDS_ERR_INVALID;

    const uint8_t *src = ctx.pixelData;
    union { uint8_t rgba[64]; float frgb[16*3]; } blk;

    for (int by_i = 0; by_i < by; by_i++) {
        for (int bx_i = 0; bx_i < bx; bx_i++) {
            const uint8_t *block = src;
            src += bpb;

            memset(&blk, 0, sizeof(blk));
            int is6H = (ctx.fmt == DDS_FMT_BC6H);

            if (is6H) {
                bcdec_bc6h_float(block, blk.frgb, 4*3, ctx.isSigned);
            } else {
                switch (ctx.fmt) {
                case DDS_FMT_BC1: bcdec_bc1(block, blk.rgba, 4*4); break;
                case DDS_FMT_BC2: bcdec_bc2(block, blk.rgba, 4*4); break;
                case DDS_FMT_BC3: bcdec_bc3(block, blk.rgba, 4*4); break;
                case DDS_FMT_BC4: bcdec_bc4(block, blk.rgba, 4*1); break;
                case DDS_FMT_BC5: bcdec_bc5(block, blk.rgba, 4*2); break;
                case DDS_FMT_BC7: bcdec_bc7(block, blk.rgba, 4*4); break;
                default: return DDS_ERR_UNSUPPORTED;
                }
            }

            for (int py = 0; py < 4; py++) {
                int iy = by_i * 4 + py;
                if (iy >= h) continue;
                for (int px = 0; px < 4; px++) {
                    int ix = bx_i * 4 + px;
                    if (ix >= w) continue;
                    int dst_off = (iy * w + ix) * 4;
                    if (is6H) {
                        float fr = blk.frgb[(py*4+px)*3+0];
                        float fg = blk.frgb[(py*4+px)*3+1];
                        float fb = blk.frgb[(py*4+px)*3+2];
                        out[dst_off] = fr; out[dst_off+1] = fg;
                        out[dst_off+2] = fb; out[dst_off+3] = 1.0f;
                    } else if (ctx.fmt == DDS_FMT_BC4) {
                        float v = blk.rgba[(py*4+px)] / 255.0f;
                        out[dst_off] = v; out[dst_off+1] = v;
                        out[dst_off+2] = v; out[dst_off+3] = 1.0f;
                    } else if (ctx.fmt == DDS_FMT_BC5) {
                        out[dst_off]   = blk.rgba[(py*4+px)*2+0] / 255.0f;
                        out[dst_off+1] = blk.rgba[(py*4+px)*2+1] / 255.0f;
                        out[dst_off+2] = 0.0f; out[dst_off+3] = 1.0f;
                    } else {
                        out[dst_off]   = blk.rgba[(py*4+px)*4+0] / 255.0f;
                        out[dst_off+1] = blk.rgba[(py*4+px)*4+1] / 255.0f;
                        out[dst_off+2] = blk.rgba[(py*4+px)*4+2] / 255.0f;
                        out[dst_off+3] = blk.rgba[(py*4+px)*4+3] / 255.0f;
                    }
                }
            }
        }
    }
    return DDS_OK;
}

// ── Header write helpers ──────────────────────────────────────────────────────

static int32_t compute_compressed_size(int32_t w, int32_t h, int fmt) {
    int bpb = bytes_per_block(fmt);
    if (bpb < 0) return 0;
    return blocks_in_dim(w) * blocks_in_dim(h) * bpb;
}

static void write_dx9_header(uint8_t *buf, int32_t w, int32_t h,
                              int32_t linearSize, uint32_t fcc, int mipLevels) {
    memset(buf, 0, DDS_HEADER_SIZE);
    write_u32(buf,      DDS_MAGIC);
    write_u32(buf + 4,  124);  // dwSize of DDSURFACEDESC2
    uint32_t flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT | DDSD_LINEARSIZE;
    if (mipLevels > 1) flags |= DDSD_MIPMAPCOUNT;
    write_u32(buf + 8,  flags);
    write_u32(buf + 12, (uint32_t)h);
    write_u32(buf + 16, (uint32_t)w);
    write_u32(buf + 20, (uint32_t)linearSize); // dwPitchOrLinearSize
    write_u32(buf + 28, (uint32_t)mipLevels);  // dwMipMapCount
    // ddpf at offset 76
    write_u32(buf + 76, 32);         // ddpf.dwSize
    write_u32(buf + 80, DDPF_FOURCC); // ddpf.dwFlags
    write_u32(buf + 84, fcc);         // ddpf.dwFourCC
    // ddsCaps at offset 108
    uint32_t caps = DDSCAPS_TEXTURE;
    if (mipLevels > 1) caps |= DDSCAPS_MIPMAP | DDSCAPS_COMPLEX;
    write_u32(buf + 108, caps);
}

static void write_dx10_header(uint8_t *buf, int32_t w, int32_t h,
                               int32_t pitchOrLinearSize, uint32_t dxgiFmt,
                               bool isCompressed, int mipLevels) {
    memset(buf, 0, DDS_HEADER_SIZE + DXT10_EXT_SIZE);
    write_u32(buf,      DDS_MAGIC);
    write_u32(buf + 4,  124);
    uint32_t flags = DDSD_CAPS | DDSD_HEIGHT | DDSD_WIDTH | DDSD_PIXELFORMAT;
    flags |= isCompressed ? DDSD_LINEARSIZE : DDSD_PITCH;
    if (mipLevels > 1) flags |= DDSD_MIPMAPCOUNT;
    write_u32(buf + 8,  flags);
    write_u32(buf + 12, (uint32_t)h);
    write_u32(buf + 16, (uint32_t)w);
    write_u32(buf + 20, (uint32_t)pitchOrLinearSize);
    write_u32(buf + 28, (uint32_t)mipLevels);
    write_u32(buf + 76, 32);
    write_u32(buf + 80, DDPF_FOURCC);
    write_u32(buf + 84, DDS_DX10_FOURCC);
    uint32_t caps = DDSCAPS_TEXTURE;
    if (mipLevels > 1) caps |= DDSCAPS_MIPMAP | DDSCAPS_COMPLEX;
    write_u32(buf + 108, caps);
    // DX10 extension
    uint8_t *ext = buf + DDS_HEADER_SIZE;
    write_u32(ext,      dxgiFmt);
    write_u32(ext + 4,  D3D10_RESOURCE_DIMENSION_TEXTURE2D);
    write_u32(ext + 8,  0);
    write_u32(ext + 12, 1); // arraySize
    write_u32(ext + 16, 0);
}

// ── Mip helpers ───────────────────────────────────────────────────────────────

static inline int32_t mip_dim(int32_t d, int level) {
    int32_t v = d >> level;
    return v < 1 ? 1 : v;
}

int dds_max_mip_levels(int32_t width, int32_t height, int minDim) {
    if (width <= 0 || height <= 0 || minDim <= 0) return 1;
    int levels = 1;
    int32_t w = width, h = height;
    while ((w >> 1) >= minDim && (h >> 1) >= minDim) {
        w >>= 1; h >>= 1; levels++;
    }
    return levels;
}

// 2x2 box-filter downscale (RGBA8). Output dims are (w/2, h/2) clamped to >=1.
static void downscale_box_u8(const uint8_t *src, int32_t sw, int32_t sh,
                              uint8_t *dst, int32_t dw, int32_t dh) {
    for (int y = 0; y < dh; y++) {
        int sy0 = y * 2;
        int sy1 = sy0 + 1; if (sy1 >= sh) sy1 = sh - 1;
        for (int x = 0; x < dw; x++) {
            int sx0 = x * 2;
            int sx1 = sx0 + 1; if (sx1 >= sw) sx1 = sw - 1;
            const uint8_t *p00 = src + (sy0 * sw + sx0) * 4;
            const uint8_t *p01 = src + (sy0 * sw + sx1) * 4;
            const uint8_t *p10 = src + (sy1 * sw + sx0) * 4;
            const uint8_t *p11 = src + (sy1 * sw + sx1) * 4;
            uint8_t *d = dst + (y * dw + x) * 4;
            for (int c = 0; c < 4; c++) {
                d[c] = (uint8_t)((p00[c] + p01[c] + p10[c] + p11[c] + 2) >> 2);
            }
        }
    }
}

// 2x2 box-filter downscale (float RGBA).
static void downscale_box_f32(const float *src, int32_t sw, int32_t sh,
                               float *dst, int32_t dw, int32_t dh) {
    for (int y = 0; y < dh; y++) {
        int sy0 = y * 2;
        int sy1 = sy0 + 1; if (sy1 >= sh) sy1 = sh - 1;
        for (int x = 0; x < dw; x++) {
            int sx0 = x * 2;
            int sx1 = sx0 + 1; if (sx1 >= sw) sx1 = sw - 1;
            const float *p00 = src + (sy0 * sw + sx0) * 4;
            const float *p01 = src + (sy0 * sw + sx1) * 4;
            const float *p10 = src + (sy1 * sw + sx0) * 4;
            const float *p11 = src + (sy1 * sw + sx1) * 4;
            float *d = dst + (y * dw + x) * 4;
            for (int c = 0; c < 4; c++) {
                d[c] = 0.25f * (p00[c] + p01[c] + p10[c] + p11[c]);
            }
        }
    }
}

// ── dds_get_encoded_size ──────────────────────────────────────────────────────

int32_t dds_get_encoded_size(int32_t width, int32_t height, int fmt, int mipLevels, int headerMode) {
    if (width <= 0 || height <= 0 || mipLevels < 1) return DDS_ERR_INVALID;

    bool needsDx10 = (fmt == DDS_FMT_BC6H || fmt == DDS_FMT_BC7 || fmt == DDS_FMT_RGBA32F);
    bool useDx10   = needsDx10 || (headerMode == DDS_HEADER_DX10);

    int32_t hdrSize = (int32_t)DDS_HEADER_SIZE + (useDx10 ? (int32_t)DXT10_EXT_SIZE : 0);

    int32_t total = 0;
    for (int lvl = 0; lvl < mipLevels; lvl++) {
        int32_t w = mip_dim(width, lvl);
        int32_t h = mip_dim(height, lvl);
        int32_t lvlSize;
        if (fmt == DDS_FMT_RGBA8)         lvlSize = w * h * 4;
        else if (fmt == DDS_FMT_RGBA32F)  lvlSize = w * h * 16;
        else {
            lvlSize = compute_compressed_size(w, h, fmt);
            if (lvlSize == 0) return DDS_ERR_INVALID;
        }
        total += lvlSize;
    }
    return hdrSize + total;
}

// ── dds_encode ───────────────────────────────────────────────────────────────

static void encode_bcx_level(const uint8_t *pixels, int32_t width, int32_t height,
                              int fmt, uint8_t *dst,
                              const bc7enc_compress_block_params *bc7params) {
    int bx = blocks_in_dim(width), by_count = blocks_in_dim(height);
    uint8_t blk[64];
    for (int by = 0; by < by_count; by++) {
        for (int bxi = 0; bxi < bx; bxi++) {
            for (int py = 0; py < 4; py++) {
                int iy = by * 4 + py;
                if (iy >= height) iy = height - 1;
                for (int px = 0; px < 4; px++) {
                    int ix = bxi * 4 + px;
                    if (ix >= width) ix = width - 1;
                    const uint8_t *src = pixels + (iy * width + ix) * 4;
                    memcpy(blk + (py * 4 + px) * 4, src, 4);
                }
            }
            if (fmt == DDS_FMT_BC1) {
                rgbcx::encode_bc1(10, dst, blk, true, false);
                dst += 8;
            } else if (fmt == DDS_FMT_BC3) {
                rgbcx::encode_bc3(10, dst, blk);
                dst += 16;
            } else { // BC7
                bc7enc_compress_block(dst, blk, bc7params);
                dst += 16;
            }
        }
    }
}

int dds_encode(const uint8_t *pixels, int32_t width, int32_t height,
               int fmt, int mipLevels, int headerMode, uint8_t *out, int32_t outSize) {
    if (!pixels || !out || width <= 0 || height <= 0 || mipLevels < 1) return DDS_ERR_INVALID;
    if (fmt != DDS_FMT_BC1 && fmt != DDS_FMT_BC3 && fmt != DDS_FMT_BC7)
        return DDS_ERR_UNSUPPORTED;

    int32_t needed = dds_get_encoded_size(width, height, fmt, mipLevels, headerMode);
    if (needed < 0 || outSize < needed) return DDS_ERR_MEMORY;

    bool useDx10 = (fmt == DDS_FMT_BC7) || (headerMode == DDS_HEADER_DX10);
    int32_t hdrSize = (int32_t)DDS_HEADER_SIZE + (useDx10 ? (int32_t)DXT10_EXT_SIZE : 0);
    int32_t mip0Size = compute_compressed_size(width, height, fmt);

    if (useDx10) {
        uint32_t dxgi;
        if (fmt == DDS_FMT_BC1) dxgi = DXGI_FORMAT_BC1_UNORM;
        else if (fmt == DDS_FMT_BC3) dxgi = DXGI_FORMAT_BC3_UNORM;
        else dxgi = DXGI_FORMAT_BC7_UNORM;
        write_dx10_header(out, width, height, mip0Size, dxgi, true, mipLevels);
    } else {
        uint32_t fcc;
        if (fmt == DDS_FMT_BC1) fcc = make_fourcc('D','X','T','1');
        else fcc = make_fourcc('D','X','T','5'); // BC3
        write_dx9_header(out, width, height, mip0Size, fcc, mipLevels);
    }

    static bool rgbcx_init_done = false;
    if (!rgbcx_init_done) { rgbcx::init(); rgbcx_init_done = true; }
    static bool bc7enc_init_done = false;
    if (!bc7enc_init_done) { bc7enc_compress_block_init(); bc7enc_init_done = true; }

    bc7enc_compress_block_params bc7params;
    bc7enc_compress_block_params_init(&bc7params);

    uint8_t *dst = out + hdrSize;
    encode_bcx_level(pixels, width, height, fmt, dst, &bc7params);
    dst += mip0Size;

    if (mipLevels > 1) {
        int32_t maxBytes = mip_dim(width, 1) * mip_dim(height, 1) * 4;
        uint8_t *bufA = (uint8_t *)malloc((size_t)maxBytes);
        uint8_t *bufB = (uint8_t *)malloc((size_t)maxBytes);
        if (!bufA || !bufB) { free(bufA); free(bufB); return DDS_ERR_MEMORY; }

        int32_t curW = mip_dim(width, 1), curH = mip_dim(height, 1);
        downscale_box_u8(pixels, width, height, bufA, curW, curH);
        encode_bcx_level(bufA, curW, curH, fmt, dst, &bc7params);
        dst += compute_compressed_size(curW, curH, fmt);

        uint8_t *src = bufA, *dstBuf = bufB;
        int32_t prevW = curW, prevH = curH;
        for (int lvl = 2; lvl < mipLevels; lvl++) {
            curW = mip_dim(width, lvl); curH = mip_dim(height, lvl);
            downscale_box_u8(src, prevW, prevH, dstBuf, curW, curH);
            encode_bcx_level(dstBuf, curW, curH, fmt, dst, &bc7params);
            dst += compute_compressed_size(curW, curH, fmt);
            uint8_t *tmp = src; src = dstBuf; dstBuf = tmp;
            prevW = curW; prevH = curH;
        }
        free(bufA); free(bufB);
    }
    return DDS_OK;
}

// ── dds_encode_f32 ────────────────────────────────────────────────────────────

static void encode_bc6h_level(const float *pixels, int32_t width, int32_t height, uint8_t *dst) {
    int bx = blocks_in_dim(width), by_count = blocks_in_dim(height);
    float blk[64];
    for (int by = 0; by < by_count; by++) {
        for (int bxi = 0; bxi < bx; bxi++) {
            for (int py = 0; py < 4; py++) {
                int iy = by * 4 + py;
                if (iy >= height) iy = height - 1;
                for (int px = 0; px < 4; px++) {
                    int ix = bxi * 4 + px;
                    if (ix >= width) ix = width - 1;
                    const float *src = pixels + (iy * width + ix) * 4;
                    float *bdst = blk + (py * 4 + px) * 4;
                    bdst[0] = src[0]; bdst[1] = src[1];
                    bdst[2] = src[2]; bdst[3] = src[3];
                }
            }
            bc6h_encode_block(blk, dst);
            dst += 16;
        }
    }
}

int dds_encode_f32(const float *pixels, int32_t width, int32_t height,
                   int fmt, int mipLevels, int /*headerMode*/,
                   uint8_t *out, int32_t outSize) {
    if (!pixels || !out || width <= 0 || height <= 0 || mipLevels < 1) return DDS_ERR_INVALID;
    if (fmt != DDS_FMT_BC6H && fmt != DDS_FMT_RGBA32F) return DDS_ERR_UNSUPPORTED;

    int32_t needed = dds_get_encoded_size(width, height, fmt, mipLevels, DDS_HEADER_DX10);
    if (needed < 0 || outSize < needed) return DDS_ERR_MEMORY;

    int32_t hdrSize = (int32_t)DDS_HEADER_SIZE + (int32_t)DXT10_EXT_SIZE;

    if (fmt == DDS_FMT_RGBA32F) {
        int32_t pitchBytes = width * 16;
        write_dx10_header(out, width, height, pitchBytes, DXGI_FORMAT_R32G32B32A32_FLOAT, false, mipLevels);
        uint8_t *dst = out + hdrSize;
        memcpy(dst, pixels, (size_t)(width * height * 16));
        dst += width * height * 16;
        if (mipLevels > 1) {
            int32_t maxFloats = mip_dim(width, 1) * mip_dim(height, 1) * 4;
            float *bufA = (float *)malloc((size_t)maxFloats * sizeof(float));
            float *bufB = (float *)malloc((size_t)maxFloats * sizeof(float));
            if (!bufA || !bufB) { free(bufA); free(bufB); return DDS_ERR_MEMORY; }
            int32_t curW = mip_dim(width, 1), curH = mip_dim(height, 1);
            downscale_box_f32(pixels, width, height, bufA, curW, curH);
            memcpy(dst, bufA, (size_t)(curW * curH * 16));
            dst += curW * curH * 16;
            float *src = bufA, *dstBuf = bufB;
            int32_t prevW = curW, prevH = curH;
            for (int lvl = 2; lvl < mipLevels; lvl++) {
                curW = mip_dim(width, lvl); curH = mip_dim(height, lvl);
                downscale_box_f32(src, prevW, prevH, dstBuf, curW, curH);
                memcpy(dst, dstBuf, (size_t)(curW * curH * 16));
                dst += curW * curH * 16;
                float *tmp = src; src = dstBuf; dstBuf = tmp;
                prevW = curW; prevH = curH;
            }
            free(bufA); free(bufB);
        }
        return DDS_OK;
    }

    // BC6H UF16
    int32_t mip0Size = compute_compressed_size(width, height, DDS_FMT_BC6H);
    write_dx10_header(out, width, height, mip0Size, DXGI_FORMAT_BC6H_UF16, true, mipLevels);

    uint8_t *dst = out + hdrSize;
    encode_bc6h_level(pixels, width, height, dst);
    dst += mip0Size;

    if (mipLevels > 1) {
        int32_t maxFloats = mip_dim(width, 1) * mip_dim(height, 1) * 4;
        float *bufA = (float *)malloc((size_t)maxFloats * sizeof(float));
        float *bufB = (float *)malloc((size_t)maxFloats * sizeof(float));
        if (!bufA || !bufB) { free(bufA); free(bufB); return DDS_ERR_MEMORY; }
        int32_t curW = mip_dim(width, 1), curH = mip_dim(height, 1);
        downscale_box_f32(pixels, width, height, bufA, curW, curH);
        encode_bc6h_level(bufA, curW, curH, dst);
        dst += compute_compressed_size(curW, curH, DDS_FMT_BC6H);
        float *src = bufA, *dstBuf = bufB;
        int32_t prevW = curW, prevH = curH;
        for (int lvl = 2; lvl < mipLevels; lvl++) {
            curW = mip_dim(width, lvl); curH = mip_dim(height, lvl);
            downscale_box_f32(src, prevW, prevH, dstBuf, curW, curH);
            encode_bc6h_level(dstBuf, curW, curH, dst);
            dst += compute_compressed_size(curW, curH, DDS_FMT_BC6H);
            float *tmp = src; src = dstBuf; dstBuf = tmp;
            prevW = curW; prevH = curH;
        }
        free(bufA); free(bufB);
    }
    return DDS_OK;
}
