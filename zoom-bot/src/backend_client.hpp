// HTTPS client for the Zoomer backend.
//
// Two endpoints, both authenticated with the shared BOT_INGEST_TOKEN:
//   GET  /api/v1/bot/assignments  — which meetings to be in
//   POST /api/v1/bot/observe      — per-participant state, the feed behind the
//                                   organizer's ライブ監視 console
//
// `/bot/ingest` (discrete recognition events) is still supported by the backend
// and by `IngestClient`; `/observe` is what drives the live grid, so it is the
// path the bot uses by default.
#pragma once
#include <curl/curl.h>

#include <mutex>
#include <string>
#include <nlohmann/json.hpp>

class BackendClient {
 public:
  BackendClient(std::string baseUrl, std::string token)
      : base_(std::move(baseUrl)), token_(std::move(token)) {
    curl_global_init(CURL_GLOBAL_DEFAULT);
  }
  ~BackendClient() { curl_global_cleanup(); }

  /** Meetings the bot should currently be in. Empty on any failure. */
  nlohmann::json assignments(std::string* error = nullptr) {
    std::string body;
    long code = request("GET", "/api/v1/bot/assignments", "", &body);
    if (code != 200) {
      if (error) *error = "HTTP " + std::to_string(code) + ": " + body.substr(0, 300);
      return nlohmann::json::array();
    }
    try {
      return nlohmann::json::parse(body).value("assignments", nlohmann::json::array());
    } catch (...) {
      if (error) *error = "unparseable assignments response";
      return nlohmann::json::array();
    }
  }

  /**
   * Post a batch of observations.
   * @param organizationId sent only when the bot is pinned to a meeting number
   *        and nothing else can attribute it to a tenant.
   */
  long observe(const std::string& meetingId, const std::string& organizationId,
               const nlohmann::json& observations, std::string* body = nullptr) {
    nlohmann::json payload{
        {"meetingId", meetingId},
        {"botId", botId()},
        {"observations", observations},
    };
    if (!organizationId.empty()) payload["organizationId"] = organizationId;
    return request("POST", "/api/v1/bot/observe", payload.dump(), body);
  }

 private:
  std::string base_, token_;
  std::mutex mu_;  // one easy handle at a time keeps connection reuse simple

  static const std::string& botId() {
    static const std::string id = "zoomer-bot-" + std::to_string(::getpid());
    return id;
  }

  static size_t sink(char* p, size_t s, size_t n, void* u) {
    static_cast<std::string*>(u)->append(p, s * n);
    return s * n;
  }

  long request(const char* method, const std::string& path, const std::string& data,
               std::string* out) {
    std::lock_guard<std::mutex> lk(mu_);
    CURL* h = curl_easy_init();
    if (!h) return -1;

    const std::string url = base_ + path;
    std::string resp;
    curl_slist* hdrs = nullptr;
    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
    hdrs = curl_slist_append(hdrs, ("Authorization: Bearer " + token_).c_str());

    curl_easy_setopt(h, CURLOPT_URL, url.c_str());
    if (std::string(method) == "POST") {
      curl_easy_setopt(h, CURLOPT_POST, 1L);
      curl_easy_setopt(h, CURLOPT_POSTFIELDS, data.c_str());
      curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, static_cast<long>(data.size()));
    }
    curl_easy_setopt(h, CURLOPT_HTTPHEADER, hdrs);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, &BackendClient::sink);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, &resp);
    curl_easy_setopt(h, CURLOPT_TIMEOUT, 30L);
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT, 10L);
    // Snapshots make these bodies large; let curl negotiate compression.
    curl_easy_setopt(h, CURLOPT_ACCEPT_ENCODING, "");
    curl_easy_setopt(h, CURLOPT_USERAGENT, "zoomer-bot/1.0");

    CURLcode rc = curl_easy_perform(h);
    long code = 0;
    if (rc == CURLE_OK) {
      curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
    } else {
      resp = curl_easy_strerror(rc);
      code = -1;
    }
    if (out) *out = resp;
    curl_slist_free_all(hdrs);
    curl_easy_cleanup(h);
    return code;
  }
};
