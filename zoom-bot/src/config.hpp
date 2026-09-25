// Bot configuration, read from environment variables (systemd EnvironmentFile
// friendly). See config.example.env.
#pragma once
#include <cstdlib>
#include <string>

struct Config {
  // Zoom Meeting SDK app
  std::string sdk_key;
  std::string sdk_secret;

  // Meeting to join.
  //
  // Leave `meeting_number` empty for the normal mode: the bot polls
  // GET /api/v1/bot/assignments and joins whatever the backend says is live in
  // the connected Zoom account. Setting it pins the bot to one meeting, which
  // is how it is tested and how it runs when a tenant has not completed OAuth.
  std::string meeting_number;
  std::string passcode;
  std::string display_name = "Ayonix Monitor";
  std::string join_token;       // optional (local recording / join token)
  /** Required only in pinned mode, where nothing else identifies the tenant. */
  std::string organization_id;

  // Zoomer backend
  std::string zoomer_base_url;  // e.g. https://zoomer.ayonix.com
  std::string bot_ingest_token; // Bearer for /api/v1/bot/*

  // Analysis sidecar (zoom-bot/analyzer/analyzer.py), which owns MediaPipe and
  // fans out to the UXE engine for identity.
  std::string analyzer_host = "127.0.0.1";
  int analyzer_port = 9102;

  // Cadence
  /** Seconds between analyses of each participant. Overridden per meeting by
   *  the tenant's own monitoring settings when running from assignments. */
  int observe_interval_sec = 10;
  /** Seconds between assignment polls. */
  int assignment_poll_sec = 20;
  /** Seconds between snapshot uploads for the live tiles. 0 disables them. */
  int snapshot_interval_sec = 30;
  /** Re-run identity at most this often per participant; it is the expensive
   *  half of the analysis and a person does not change between frames. */
  int reauth_interval_sec = 60;
  double match_threshold = 0.5944;  // UXE far_1e-3 operating point
  /** JPEG quality for analysis frames and for the console's live tiles. */
  int jpeg_quality = 75;
  /** Longest edge of an analysed frame. 640 keeps a Zoom tile's face well above
   *  the size the landmarker needs while keeping each POST small. */
  int frame_max_edge = 640;
  /** Give up on a participant's video after this long with no frame. */
  int video_stall_sec = 15;

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
    c.organization_id = env("ZOOMER_ORGANIZATION_ID");
    c.zoomer_base_url = env("ZOOMER_BASE_URL", "https://zoomer.ayonix.com");
    c.bot_ingest_token = env("BOT_INGEST_TOKEN");
    c.analyzer_host = env("ANALYZER_HOST", c.analyzer_host);
    c.analyzer_port = envi("ANALYZER_PORT", c.analyzer_port);
    c.observe_interval_sec = envi("OBSERVE_INTERVAL_SEC", c.observe_interval_sec);
    c.assignment_poll_sec = envi("ASSIGNMENT_POLL_SEC", c.assignment_poll_sec);
    c.snapshot_interval_sec = envi("SNAPSHOT_INTERVAL_SEC", c.snapshot_interval_sec);
    c.reauth_interval_sec = envi("REAUTH_INTERVAL_SEC", c.reauth_interval_sec);
    c.jpeg_quality = envi("JPEG_QUALITY", c.jpeg_quality);
    c.frame_max_edge = envi("FRAME_MAX_EDGE", c.frame_max_edge);
    c.video_stall_sec = envi("VIDEO_STALL_SEC", c.video_stall_sec);
    return c;
  }

  /** True when the bot is pinned to one meeting instead of polling for work. */
  bool pinned() const { return !meeting_number.empty(); }

  bool valid() const {
    return !sdk_key.empty() && !sdk_secret.empty() && !zoomer_base_url.empty() &&
           !bot_ingest_token.empty();
  }
};
