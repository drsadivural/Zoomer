// An I420 video frame, owned by us rather than by the SDK.
//
// Why a copy: `onRawDataFrameReceived` hands over a buffer that belongs to the
// Meeting SDK and is valid only for the duration of the callback, and the
// callback runs on the SDK's own thread. Analysis takes tens of milliseconds
// and a network round trip, which must never happen on that thread — a slow
// analyzer would stall video delivery for every participant. So the delegate
// copies the frame, and a worker thread analyses it later.
#pragma once
#include <turbojpeg.h>

#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

struct I420Frame {
  std::vector<uint8_t> y, u, v;
  int width = 0;
  int height = 0;

  bool empty() const { return width <= 0 || height <= 0 || y.empty(); }

  void assign(const uint8_t* yp, const uint8_t* up, const uint8_t* vp, int w, int h) {
    width = w;
    height = h;
    const size_t ySize = static_cast<size_t>(w) * h;
    const int cw = (w + 1) / 2, ch = (h + 1) / 2;
    const size_t cSize = static_cast<size_t>(cw) * ch;
    y.assign(yp, yp + ySize);
    u.assign(up, up + cSize);
    v.assign(vp, vp + cSize);
  }
};

namespace frameutil {

/** Nearest-neighbour plane resample. Good enough: the consumer is a face
 *  detector working at a fraction of this resolution anyway, and a separable
 *  filter would cost more than it buys. */
inline void resamplePlane(const uint8_t* src, int sw, int sh, uint8_t* dst, int dw, int dh) {
  for (int yy = 0; yy < dh; ++yy) {
    const int sy = sh == dh ? yy : (yy * sh) / dh;
    const uint8_t* srow = src + static_cast<size_t>(sy) * sw;
    uint8_t* drow = dst + static_cast<size_t>(yy) * dw;
    for (int xx = 0; xx < dw; ++xx) drow[xx] = srow[sw == dw ? xx : (xx * sw) / dw];
  }
}

/**
 * Scales a frame so its longest edge is at most `maxEdge`.
 * Dimensions are forced even, because I420 chroma is half-resolution.
 */
inline I420Frame downscale(const I420Frame& in, int maxEdge) {
  const int longest = in.width > in.height ? in.width : in.height;
  if (longest <= maxEdge || in.empty()) return in;

  const double scale = static_cast<double>(maxEdge) / longest;
  int dw = static_cast<int>(in.width * scale) & ~1;
  int dh = static_cast<int>(in.height * scale) & ~1;
  if (dw < 2) dw = 2;
  if (dh < 2) dh = 2;

  const int scw = (in.width + 1) / 2, sch = (in.height + 1) / 2;
  const int dcw = dw / 2, dch = dh / 2;

  I420Frame out;
  out.width = dw;
  out.height = dh;
  out.y.resize(static_cast<size_t>(dw) * dh);
  out.u.resize(static_cast<size_t>(dcw) * dch);
  out.v.resize(static_cast<size_t>(dcw) * dch);

  resamplePlane(in.y.data(), in.width, in.height, out.y.data(), dw, dh);
  resamplePlane(in.u.data(), scw, sch, out.u.data(), dcw, dch);
  resamplePlane(in.v.data(), scw, sch, out.v.data(), dcw, dch);
  return out;
}

}  // namespace frameutil
