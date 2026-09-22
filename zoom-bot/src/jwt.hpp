// Meeting SDK auth JWT (HS256) — signed with the SDK Secret.
// Payload matches Zoom's Meeting SDK spec: appKey/sdkKey/iat/exp/tokenExp.
#pragma once
#include <openssl/hmac.h>
#include <ctime>
#include <string>

namespace jwt {

inline std::string b64url(const unsigned char* data, size_t len) {
  static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  std::string out;
  for (size_t i = 0; i < len; i += 3) {
    unsigned n = data[i] << 16;
    if (i + 1 < len) n |= data[i + 1] << 8;
    if (i + 2 < len) n |= data[i + 2];
    out += T[(n >> 18) & 63];
    out += T[(n >> 12) & 63];
    if (i + 1 < len) out += T[(n >> 6) & 63];
    if (i + 2 < len) out += T[n & 63];
  }
  return out; // no padding, per JWT
}
inline std::string b64url(const std::string& s) {
  return b64url(reinterpret_cast<const unsigned char*>(s.data()), s.size());
}

/** Build a Meeting SDK JWT valid for `ttl_sec` (default 2h). */
inline std::string meetingSdkToken(const std::string& sdkKey, const std::string& sdkSecret,
                                   long ttl_sec = 7200) {
  const long iat = static_cast<long>(std::time(nullptr));
  const long exp = iat + ttl_sec;
  std::string header = R"({"alg":"HS256","typ":"JWT"})";
  std::string payload = std::string("{\"appKey\":\"") + sdkKey + "\",\"sdkKey\":\"" + sdkKey +
                        "\",\"iat\":" + std::to_string(iat) + ",\"exp\":" + std::to_string(exp) +
                        ",\"tokenExp\":" + std::to_string(exp) + "}";
  std::string signingInput = b64url(header) + "." + b64url(payload);
  unsigned char mac[EVP_MAX_MD_SIZE];
  unsigned int maclen = 0;
  HMAC(EVP_sha256(), sdkSecret.data(), static_cast<int>(sdkSecret.size()),
       reinterpret_cast<const unsigned char*>(signingInput.data()), signingInput.size(), mac, &maclen);
  return signingInput + "." + b64url(mac, maclen);
}

}  // namespace jwt
