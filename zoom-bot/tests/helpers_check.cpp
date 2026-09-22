// Compile + smoke-check the non-SDK helpers (no Zoom SDK required).
#include "config.hpp"
#include "jwt.hpp"
#include "engine_client.hpp"
#include "ingest_client.hpp"
#include "yuv_jpeg.hpp"
#include <cstdio>
int main() {
  Config c = Config::fromEnv();
  std::string t = jwt::meetingSdkToken("KEY", "SECRET");
  // JWT must be three dot-separated segments.
  int dots = 0; for (char ch : t) if (ch == '.') dots++;
  std::printf("jwt segments ok: %s\n", dots == 2 ? "yes" : "no");
  // I420 encode of a tiny gray frame -> base64 JPEG non-empty.
  int w = 16, h = 16; std::string y(w*h, 128), u((w/2)*(h/2), 128), v((w/2)*(h/2), 128);
  std::string b64 = yuvjpeg::encodeI420((unsigned char*)y.data(), (unsigned char*)u.data(), (unsigned char*)v.data(), w, h);
  std::printf("jpeg encode ok: %s (%zu b64 chars)\n", b64.empty() ? "no" : "yes", b64.size());
  EngineClient e(c.engine_host, c.engine_port);
  IngestClient ing(c.zoomer_base_url, "tok");
  (void)e; (void)ing;
  std::printf("helpers compiled and ran.\n");
  return 0;
}
