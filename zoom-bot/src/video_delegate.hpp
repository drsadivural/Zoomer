// Per-participant raw-video receiver. One instance is bound (via createRenderer)
// to each Zoom user; the SDK calls onRawDataFrameReceived for that user's frames.
// It throttles, JPEG-encodes, asks the UXE engine to identify, and queues an
// event for the main loop to POST to /api/v1/bot/ingest.
#pragma once
#include "rawdata/rawdata_renderer_interface.h"
#include "zoom_sdk_raw_data_def.h"
#include "config.hpp"
#include "engine_client.hpp"
#include "yuv_jpeg.hpp"
#include <chrono>
#include <mutex>
#include <string>
#include <nlohmann/json.hpp>

using namespace ZOOMSDK;  // TODO(sdk): confirm the SDK namespace macro for 7.1.5

/** Thread-safe queue of ingest event objects, drained by the main loop. */
struct EventSink {
  std::mutex mu;
  nlohmann::json events = nlohmann::json::array();
  void push(nlohmann::json e) {
    std::lock_guard<std::mutex> lk(mu);
    events.push_back(std::move(e));
  }
  nlohmann::json drain() {
    std::lock_guard<std::mutex> lk(mu);
    nlohmann::json out = events;
    events = nlohmann::json::array();
    return out;
  }
};

class ParticipantVideoDelegate : public IZoomSDKRendererDelegate {
 public:
  ParticipantVideoDelegate(uint32_t userId, std::string name, EngineClient* engine, EventSink* sink,
                           Config cfg)
      : userId_(userId), name_(std::move(name)), engine_(engine), sink_(sink), cfg_(std::move(cfg)) {}

  void onRawDataFrameReceived(YUVRawDataI420* data) override {
    if (!data) return;
    // 1) frame stride
    if (++frame_ % cfg_.frame_stride != 0) return;
    // 2) time throttle (re-identify at most every reauth_interval_sec)
    const auto now = std::chrono::steady_clock::now();
    if (last_.time_since_epoch().count() != 0 &&
        std::chrono::duration_cast<std::chrono::seconds>(now - last_).count() < cfg_.reauth_interval_sec)
      return;
    last_ = now;

    const int w = data->GetStreamWidth(), h = data->GetStreamHeight();
    if (w <= 0 || h <= 0) {
      emit("FACE_ABSENT", nullptr);  // video on but no frame content
      return;
    }
    const std::string b64 = yuvjpeg::encodeI420(
        reinterpret_cast<unsigned char*>(data->GetYBuffer()),
        reinterpret_cast<unsigned char*>(data->GetUBuffer()),
        reinterpret_cast<unsigned char*>(data->GetVBuffer()), w, h);
    if (b64.empty()) return;

    nlohmann::json r = engine_->identify(b64, 3);
    // Engine result contract (UXE server.py + a small faceCount addition):
    //   { ok, faceCount, matches: [ {id, score}... ] }   score in 0..1
    const int faces = r.value("faceCount", r.contains("matches") ? 1 : 0);
    if (faces == 0) {
      emit("FACE_ABSENT", &b64);
    } else if (faces >= 2) {
      emit("MULTIPLE_FACES", &b64, faces);
    } else {
      const auto matches = r.value("matches", nlohmann::json::array());
      if (!matches.empty()) {
        const auto& top = matches[0];
        const double score = top.value("score", 0.0);
        if (score >= cfg_.match_threshold) {
          emit("MATCH_OK", nullptr, faces, top.value("id", std::string()), score);
        } else {
          emit("MATCH_FAIL", &b64, faces, std::string(), score);  // other/unenrolled
        }
      } else {
        emit("MATCH_FAIL", &b64, faces);
      }
    }
    // TODO(engine): also request eye-state so EYES_CLOSED can be emitted.
  }

  void onRendererBeDestroyed() override {}
  void onRawDataStatusChanged(RawDataStatus status) override {
    if (status == RawData_Off) emit("CAMERA_STOPPED", nullptr);  // video turned off
  }
  uint32_t userId() const { return userId_; }

 private:
  uint32_t userId_;
  std::string name_;
  EngineClient* engine_;
  EventSink* sink_;
  Config cfg_;
  uint64_t frame_ = 0;
  std::chrono::steady_clock::time_point last_{};

  void emit(const char* type, const std::string* evidenceB64, int faceCount = 0,
            const std::string& traineeId = {}, double score = 0.0) {
    nlohmann::json e{
        {"eventId", std::to_string(userId_) + "-" + std::to_string(::time(nullptr)) + "-" + std::to_string(frame_)},
        {"zoomUserId", std::to_string(userId_)},
        {"zoomUserName", name_},
        {"type", type},
        {"capturedAt", static_cast<long long>(::time(nullptr)) * 1000},
    };
    if (faceCount) e["faceCount"] = faceCount;
    if (type == std::string("MULTIPLE_FACES")) e["frameCount"] = cfg_.frame_stride;  // conservative
    if (!traineeId.empty()) e["traineeId"] = traineeId;
    if (score > 0) e["matchScore"] = score;
    if (evidenceB64) e["evidence"] = yuvjpeg::dataUrl(*evidenceB64);
    sink_->push(std::move(e));
  }
};
