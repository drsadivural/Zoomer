// Compile + smoke-check the non-SDK helpers (no Zoom SDK required).
//
//   cmake --build build --target helpers_check && ./build/helpers_check
//
// Deliberately covers the pieces that have no other test: the JWT shape, the
// I420 -> JPEG path, and the frame downscaler's dimension arithmetic. The
// wire contract with the backend is tested from the other side, in
// tests/bot-observation.test.ts.
#include "config.hpp"
#include "jwt.hpp"
#include "analyzer_client.hpp"
#include "backend_client.hpp"
#include "frame.hpp"
#include "yuv_jpeg.hpp"

#include <cstdio>
#include <string>

namespace {
int failures = 0;
void check(const char* what, bool ok, const std::string& detail = {}) {
  std::printf("  %s %s%s%s\n", ok ? "ok  " : "FAIL", what, detail.empty() ? "" : " — ",
              detail.c_str());
  if (!ok) failures++;
}
}  // namespace

int main() {
  Config c = Config::fromEnv();

  const std::string t = jwt::meetingSdkToken("KEY", "SECRET");
  int dots = 0;
  for (char ch : t) if (ch == '.') dots++;
  check("JWT has three segments", dots == 2);

  // I420 encode of a tiny grey frame -> non-empty base64 JPEG.
  const int w = 16, h = 16;
  std::string y(w * h, 128), u((w / 2) * (h / 2), 128), v((w / 2) * (h / 2), 128);
  const std::string b64 = yuvjpeg::encodeI420(reinterpret_cast<unsigned char*>(y.data()),
                                              reinterpret_cast<unsigned char*>(u.data()),
                                              reinterpret_cast<unsigned char*>(v.data()), w, h);
  check("I420 -> base64 JPEG", !b64.empty(), std::to_string(b64.size()) + " chars");
  check("data URL prefix", yuvjpeg::dataUrl("x").rfind("data:image/jpeg;base64,", 0) == 0);

  // Downscaler: dimensions must stay even, because I420 chroma is half-res.
  I420Frame big;
  std::string by(1280 * 720, 128), bu(640 * 360, 128), bv(640 * 360, 128);
  big.assign(reinterpret_cast<unsigned char*>(by.data()),
             reinterpret_cast<unsigned char*>(bu.data()),
             reinterpret_cast<unsigned char*>(bv.data()), 1280, 720);
  const I420Frame small = frameutil::downscale(big, 640);
  check("downscale caps the long edge", small.width <= 640,
        std::to_string(small.width) + "x" + std::to_string(small.height));
  check("downscale keeps dimensions even", small.width % 2 == 0 && small.height % 2 == 0);
  check("downscale keeps plane sizes consistent",
        small.y.size() == static_cast<size_t>(small.width) * small.height &&
            small.u.size() == static_cast<size_t>(small.width / 2) * (small.height / 2));
  const I420Frame untouched = frameutil::downscale(small, 640);
  check("downscale is a no-op below the cap", untouched.width == small.width);

  // Construction only: neither of these talks to anything here.
  AnalyzerClient analyzer(c.analyzer_host, c.analyzer_port);
  BackendClient backend(c.zoomer_base_url, "token");
  (void)analyzer;
  (void)backend;

  std::printf("%s\n", failures ? "FAILURES" : "all helper checks passed");
  return failures ? 1 : 0;
}
