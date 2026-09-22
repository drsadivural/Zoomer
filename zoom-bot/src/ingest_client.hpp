// Posts batched recognition events to the Zoomer backend
// (POST /api/v1/bot/ingest, Bearer BOT_INGEST_TOKEN).
#pragma once
#include <curl/curl.h>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

class IngestClient {
 public:
  IngestClient(std::string baseUrl, std::string token)
      : url_(std::move(baseUrl) + "/api/v1/bot/ingest"), token_(std::move(token)) {
    curl_global_init(CURL_GLOBAL_DEFAULT);
  }
  ~IngestClient() { curl_global_cleanup(); }

  /** events: array of the /bot/ingest event objects. Returns HTTP status. */
  long post(const std::string& meetingId, const nlohmann::json& events, std::string* body = nullptr) {
    nlohmann::json payload{{"meetingId", meetingId}, {"botId", "zoomer-bot"}, {"events", events}};
    std::string data = payload.dump();
    CURL* h = curl_easy_init();
    if (!h) return -1;
    std::string resp;
    curl_slist* hdrs = nullptr;
    hdrs = curl_slist_append(hdrs, "Content-Type: application/json");
    hdrs = curl_slist_append(hdrs, ("Authorization: Bearer " + token_).c_str());
    hdrs = curl_slist_append(hdrs, ("Idempotency-Key: " + genKey()).c_str());
    curl_easy_setopt(h, CURLOPT_URL, url_.c_str());
    curl_easy_setopt(h, CURLOPT_POST, 1L);
    curl_easy_setopt(h, CURLOPT_POSTFIELDS, data.c_str());
    curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE, static_cast<long>(data.size()));
    curl_easy_setopt(h, CURLOPT_HTTPHEADER, hdrs);
    curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, &IngestClient::sink);
    curl_easy_setopt(h, CURLOPT_WRITEDATA, &resp);
    curl_easy_setopt(h, CURLOPT_TIMEOUT, 30L);
    CURLcode rc = curl_easy_perform(h);
    long code = 0;
    if (rc == CURLE_OK) curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &code);
    if (body) *body = resp;
    curl_slist_free_all(hdrs);
    curl_easy_cleanup(h);
    return code;
  }

 private:
  std::string url_, token_;
  static size_t sink(char* p, size_t s, size_t n, void* u) {
    static_cast<std::string*>(u)->append(p, s * n);
    return s * n;
  }
  static std::string genKey() {
    // cheap unique idempotency key
    return std::to_string(::time(nullptr)) + "-" + std::to_string(::rand());
  }
};
