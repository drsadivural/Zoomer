// TCP JSON client for the analysis sidecar (zoom-bot/analyzer/analyzer.py).
//
// One request per sampled frame returns everything an observation needs: face
// count, the primary face's box, head pose, eye state, and — when asked — the
// identity from the UXE engine. Keeping identity behind the same call means the
// bot makes one round trip per frame rather than three.
//
// Protocol: one JSON object per line in, one JSON object per line out.
#pragma once
#include <arpa/inet.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <string>
#include <nlohmann/json.hpp>

class AnalyzerClient {
 public:
  AnalyzerClient(std::string host, int port, int timeoutSec = 20)
      : host_(std::move(host)), port_(port), timeout_(timeoutSec) {}

  /**
   * Analyse one JPEG frame.
   * @param identify ask the UXE engine who this is; skipped on most frames
   *                 because it is the expensive half.
   */
  nlohmann::json analyze(const std::string& jpegB64, bool identify) {
    return call({{"op", "analyze"}, {"image_b64", jpegB64}, {"identify", identify}});
  }

  /** Landmarks-only eye state, cheap enough to call several times a second. */
  nlohmann::json eyes(const std::string& jpegB64) {
    return call({{"op", "eyes"}, {"image_b64", jpegB64}});
  }

  bool ping() { return call({{"op", "ping"}}).value("ok", false); }

 private:
  std::string host_;
  int port_;
  int timeout_;
  // No mutex: the sidecar is a threading TCP server and each call opens its own
  // connection, so several participants can be analysed concurrently.

  nlohmann::json call(const nlohmann::json& req) {
    int fd = ::socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return {{"ok", false}, {"error", "socket"}};

    timeval tv{timeout_, 0};
    ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    int one = 1;
    ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(static_cast<uint16_t>(port_));
    if (::inet_pton(AF_INET, host_.c_str(), &addr.sin_addr) != 1) {
      ::close(fd);
      return {{"ok", false}, {"error", "bad host"}};
    }
    if (::connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
      ::close(fd);
      return {{"ok", false}, {"error", "connect"}};
    }

    const std::string line = req.dump() + "\n";
    size_t sent = 0;
    while (sent < line.size()) {
      ssize_t n = ::send(fd, line.data() + sent, line.size() - sent, MSG_NOSIGNAL);
      if (n <= 0) {
        ::close(fd);
        return {{"ok", false}, {"error", "send"}};
      }
      sent += static_cast<size_t>(n);
    }

    std::string resp;
    char buf[16384];
    ssize_t n;
    while ((n = ::recv(fd, buf, sizeof(buf), 0)) > 0) {
      resp.append(buf, static_cast<size_t>(n));
      if (resp.find('\n') != std::string::npos) break;
    }
    ::close(fd);

    try {
      return nlohmann::json::parse(resp.substr(0, resp.find('\n')));
    } catch (...) {
      return {{"ok", false}, {"error", "bad_response"}};
    }
  }
};
