// Bot configuration, read from environment variables (systemd EnvironmentFile
// friendly). See config.example.env.
#pragma once
#include <cstdlib>
#include <string>

struct Config {
  // Zoom Meeting SDK app
  std::string sdk_key;
  std::string sdk_secret;
  // Meeting to join
  std::string meeting_number;   // numeric Zoom meeting id
  std::string passcode;
  std::string display_name = "Ayonix Monitor";
  std::string join_token;       // optional (local recording / join token)
  // Zoomer backend
  std::string zoomer_base_url;  // e.g. https://zoomer.ayonix.com
  std::string bot_ingest_token; // Bearer for /api/v1/bot/ingest
  // UXE engine (server.py --mode json)
  std::string engine_host = "127.0.0.1";
  int engine_port = 9101;
  // Cadence
  int frame_stride = 8;          // analyse every Nth received frame per participant
  int reauth_interval_sec = 30;  // re-identify at least this often
  int evidence_interval_sec = 300;
  double match_threshold = 0.5944; // UXE far_1e-3 operating point
  int video_width = 640;

  static std::string env(const char* k, const std::string& def = "") {
    const char* v = std::getenv(k);
    return v && *v ? std::string(v) : def;
  }
  static int envi(const char* k, int def) {
    const char* v = std::getenv(k);
    return v && *v ? std::atoi(v) : def;
  }

  static Config fromEnv() {
    Config c;
    c.sdk_key = env("ZOOM_SDK_KEY");
    c.sdk_secret = env("ZOOM_SDK_SECRET");
    c.meeting_number = env("ZOOM_MEETING_NUMBER");
    c.passcode = env("ZOOM_MEETING_PASSCODE");
    c.display_name = env("BOT_DISPLAY_NAME", c.display_name);
    c.join_token = env("ZOOM_JOIN_TOKEN");
    c.zoomer_base_url = env("ZOOMER_BASE_URL", "https://zoomer.ayonix.com");
    c.bot_ingest_token = env("BOT_INGEST_TOKEN");
    c.engine_host = env("ENGINE_HOST", c.engine_host);
    c.engine_port = envi("ENGINE_PORT", c.engine_port);
    c.frame_stride = envi("FRAME_STRIDE", c.frame_stride);
    c.reauth_interval_sec = envi("REAUTH_INTERVAL_SEC", c.reauth_interval_sec);
    c.evidence_interval_sec = envi("EVIDENCE_INTERVAL_SEC", c.evidence_interval_sec);
    return c;
  }

  bool valid() const {
    return !sdk_key.empty() && !sdk_secret.empty() && !meeting_number.empty() &&
           !zoomer_base_url.empty() && !bot_ingest_token.empty();
  }
};
