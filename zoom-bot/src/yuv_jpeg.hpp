// I420 (YUV 4:2:0 planar) -> JPEG -> base64, via libturbojpeg.
#pragma once
#include <turbojpeg.h>
#include <cstring>
#include <string>
#include <vector>

namespace yuvjpeg {

inline std::string base64(const unsigned char* data, size_t len) {
  static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve(((len + 2) / 3) * 4);
  for (size_t i = 0; i < len; i += 3) {
    unsigned n = data[i] << 16;
    if (i + 1 < len) n |= data[i + 1] << 8;
    if (i + 2 < len) n |= data[i + 2];
    out += T[(n >> 18) & 63];
    out += T[(n >> 12) & 63];
    out += (i + 1 < len) ? T[(n >> 6) & 63] : '=';
    out += (i + 2 < len) ? T[n & 63] : '=';
  }
  return out;
}

/**
 * Encode contiguous I420 planes (Y then U then V, no inter-plane padding) to a
 * base64 JPEG. Zoom delivers YUVRawDataI420 with separate plane pointers; pass
 * them via GetYBuffer/GetUBuffer/GetVBuffer.
 */
inline std::string encodeI420(const unsigned char* y, const unsigned char* u, const unsigned char* v,
                              int width, int height, int quality = 80) {
  // Pack into the contiguous YUV buffer layout turbojpeg expects for TJSAMP_420.
  const int cw = (width + 1) / 2, ch = (height + 1) / 2;
  std::vector<unsigned char> yuv(static_cast<size_t>(width) * height + 2 * cw * ch);
  std::memcpy(yuv.data(), y, static_cast<size_t>(width) * height);
  std::memcpy(yuv.data() + static_cast<size_t>(width) * height, u, static_cast<size_t>(cw) * ch);
  std::memcpy(yuv.data() + static_cast<size_t>(width) * height + cw * ch, v, static_cast<size_t>(cw) * ch);

  tjhandle tj = tjInitCompress();
  if (!tj) return {};
  unsigned char* jpeg = nullptr;
  unsigned long jpegSize = 0;
  int rc = tjCompressFromYUV(tj, yuv.data(), width, 1 /*pad*/, height, TJSAMP_420, &jpeg, &jpegSize,
                             quality, 0);
  std::string out;
  if (rc == 0 && jpeg) out = base64(jpeg, jpegSize);
  if (jpeg) tjFree(jpeg);
  tjDestroy(tj);
  return out;
}

/** Convenience: prefix a base64 JPEG as a data: URL for the evidence field. */
inline std::string dataUrl(const std::string& b64) { return "data:image/jpeg;base64," + b64; }

}  // namespace yuvjpeg
