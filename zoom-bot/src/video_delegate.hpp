// Per-participant raw-video receiver and the state the analysis loop keeps
// about that participant.
//
// The delegate does as little as possible: it copies the newest frame and
// returns. Everything expensive — JPEG encoding, the analyzer round trip, the
// HTTPS POST — happens on the bot's own analysis thread, because the callback
// runs on the Meeting SDK's thread and blocking it stalls video for the whole
// meeting.
#pragma once
#include "rawdata/rawdata_renderer_interface.h"
#include "zoom_sdk_raw_data_def.h"

#include "frame.hpp"

#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <string>

using namespace ZOOMSDK;

using Clock = std::chrono::steady_clock;

/** Everything the analysis loop needs to know about one Zoom participant. */
struct ParticipantState {
  uint32_t userId = 0;
  std::string name;
  std::string persistentId;

  /** Roster facts, updated from the SDK's participant/video/audio callbacks. */
  std::atomic<bool> videoOn{false};
  std::atomic<bool> speaking{false};
  std::atomic<bool> audioMuted{true};
  std::atomic<bool> present{true};

  /** Newest decoded frame, replaced in place. Guarded by `frameMu`. */
  std::mutex frameMu;
  I420Frame frame;
  Clock::time_point frameAt{};

  /** Analysis bookkeeping, touched only by the analysis thread. */
  Clock::time_point lastObserved{};
  Clock::time_point lastIdentified{};
  Clock::time_point lastSnapshot{};
  /** Sticky until identity is re-run, so every observation carries the
   *  participant's identity rather than only the frames it was measured on. */
  std::string traineeId;
  double identityConfidence = 0.0;
  bool reportedLeft = false;

  ParticipantState(uint32_t id, std::string n) : userId(id), name(std::move(n)) {}

  /** Takes a copy of the newest frame, or returns false if there is none. */
  bool latestFrame(I420Frame* out, Clock::time_point* at) {
    std::lock_guard<std::mutex> lk(frameMu);
    if (frame.empty()) return false;
    *out = frame;
    *at = frameAt;
    return true;
  }
};

/**
 * Receives one participant's raw video.
 *
 * Bound to a `ParticipantState` rather than owning it, so the analysis loop can
 * keep reading a participant's state while the SDK is destroying the renderer.
 */
class ParticipantVideoDelegate : public IZoomSDKRendererDelegate {
 public:
  ParticipantVideoDelegate(ParticipantState* state, int maxEdge)
      : state_(state), maxEdge_(maxEdge) {}

  void onRawDataFrameReceived(YUVRawDataI420* data) override {
    if (!data || !state_) return;
    const int w = static_cast<int>(data->GetStreamWidth());
    const int h = static_cast<int>(data->GetStreamHeight());
    if (w <= 0 || h <= 0) return;

    I420Frame incoming;
    incoming.assign(reinterpret_cast<const uint8_t*>(data->GetYBuffer()),
                    reinterpret_cast<const uint8_t*>(data->GetUBuffer()),
                    reinterpret_cast<const uint8_t*>(data->GetVBuffer()), w, h);

    // Downscale here rather than in the analysis loop: it shrinks the copy we
    // are about to hold for every participant in the meeting, and it is cheap
    // compared with everything else that touches the frame.
    I420Frame scaled = frameutil::downscale(incoming, maxEdge_);

    {
      std::lock_guard<std::mutex> lk(state_->frameMu);
      state_->frame = std::move(scaled);
      state_->frameAt = Clock::now();
    }
    state_->videoOn = true;
  }

  void onRendererBeDestroyed() override {}

  void onRawDataStatusChanged(RawDataStatus status) override {
    if (!state_) return;
    // The authoritative camera-on/off signal. `onUserVideoStatusChange` says
    // what the roster thinks; this says whether pixels are actually arriving.
    state_->videoOn = (status == RawData_On);
  }

  /** Called when the participant leaves, before the renderer is destroyed. */
  void detach() { state_ = nullptr; }

 private:
  ParticipantState* state_;
  int maxEdge_;
};
