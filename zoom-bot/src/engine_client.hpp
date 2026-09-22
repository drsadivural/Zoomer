// TCP JSON client for the UXE engine (server.py --mode json).
// Protocol: one JSON object per line in, one JSON object per line out.
#pragma once
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <mutex>
#include <string>
#include <nlohmann/json.hpp>

class EngineClient {
 public:
  EngineClient(std::string host, int port) : host_(std::move(host)), port_(port) {}

  /** 1:N identify a JPEG (base64) against the enrolled gallery. */
  nlohmann::json identify(const std::string& jpegB64, int topK = 3) {
    return call({{"op", "identify"}, {"image_b64", jpegB64}, {"top_k", topK}});
  }
  /** 1:1 compare a live JPEG against an enrolled id. */
  nlohmann::json match(const std::string& id, const std::string& jpegB64) {
    return call({{"op", "match"}, {"id", id}, {"image_b64", jpegB64}});
  }
  nlohmann::json enrol(const std::string& id, const std::string& jpegB64) {
    return call({{"op", "enrol"}, {"id", id}, {"image_b64", jpegB64}});
  }

 private:
  std::string host_;
  int port_;
  std::mutex mu_;  // server handles one request per connection; serialize

  nlohmann::json call(const nlohmann::json& req) {
    std::lock_guard<std::mutex> lk(mu_);
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return {{"ok", false}, {"error", "socket"}};
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(port_);
    ::inet_pton(AF_INET, host_.c_str(), &addr.sin_addr);
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
      ::close(fd);
      return {{"ok", false}, {"error", "connect"}};
    }
    std::string line = req.dump() + "\n";
    ::send(fd, line.data(), line.size(), 0);
    std::string resp;
    char buf[8192];
    ssize_t n;
    while ((n = ::recv(fd, buf, sizeof(buf), 0)) > 0) {
      resp.append(buf, n);
      if (resp.find('\n') != std::string::npos) break;
    }
    ::close(fd);
    try {
      return nlohmann::json::parse(resp);
    } catch (...) {
      return {{"ok", false}, {"error", "bad_response"}};
    }
  }
};
