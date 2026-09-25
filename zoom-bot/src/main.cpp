// Zoomer Meeting Bot — full lifecycle.
//
//   init SDK -> authenticate (Meeting SDK JWT) -> join a meeting -> subscribe to
//   every participant's raw video -> sample each on a timer -> analyse
//   (MediaPipe landmarks + UXE identity) -> POST /api/v1/bot/observe
//
// Which meeting to join comes from GET /api/v1/bot/assignments, so the bot needs
// no per-customer configuration: the backend knows which Zoom accounts are
// connected and which of their meetings are live. Setting ZOOM_MEETING_NUMBER
// pins it to one meeting instead, which is how it is tested and how it runs for
// a tenant that has not completed OAuth.
//
// Threading, which is the part that matters:
//   * the glib main loop thread runs every SDK callback. It must never block,
//     so callbacks only mutate small bits of state.
//   * the analysis thread does all the expensive work and owns all HTTP.
//   * the assignment thread polls the backend and marshals join/leave requests
//     back onto the glib thread via g_idle_add, because the SDK is not
//     thread-safe.
#include "zoom_sdk.h"
#include "auth_service_interface.h"
#include "meeting_service_interface.h"
#include "meeting_service_components/meeting_audio_interface.h"
#include "meeting_service_components/meeting_participants_ctrl_interface.h"
#include "meeting_service_components/meeting_video_interface.h"
#include "rawdata/zoom_rawdata_api.h"

#include <glib.h>

#include "analyzer_client.hpp"
#include "backend_client.hpp"
#include "config.hpp"
#include "frame.hpp"
#include "jwt.hpp"
#include "video_delegate.hpp"
#include "yuv_jpeg.hpp"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <csignal>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

using namespace ZOOMSDK;
using json = nlohmann::json;

namespace {

Config g_cfg;
AnalyzerClient* g_analyzer = nullptr;
BackendClient* g_backend = nullptr;

IMeetingService* g_meeting = nullptr;
IAuthService* g_auth = nullptr;
std::atomic<bool> g_authed{false};
std::atomic<bool> g_inMeeting{false};
std::atomic<bool> g_joining{false};
std::atomic<bool> g_stop{false};

/** The meeting the bot is in, or is trying to join. */
struct Assignment {
  std::string meetingId;
  std::string organizationId;
  std::string passcode;
  std::string topic;
  int observeIntervalSec = 10;
  bool snapshotsEnabled = false;
  bool identityEnabled = true;
};
std::mutex g_assignMu;
Assignment g_assignment;

std::mutex g_partsMu;
std::map<uint32_t, std::unique_ptr<ParticipantState>> g_parts;
std::map<uint32_t, std::pair<IZoomSDKRenderer*, ParticipantVideoDelegate*>> g_renderers;

int64_t nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
             std::chrono::system_clock::now().time_since_epoch())
      .count();
}

double secondsSince(Clock::time_point t) {
  if (t.time_since_epoch().count() == 0) return 1e9;  // never
  return std::chrono::duration<double>(Clock::now() - t).count();
}

/* ------------------------------------------------------------ participants */

// Must be called on the glib thread: it touches the SDK.
void subscribeUser(uint32_t uid, const std::string& name, bool videoOn) {
  std::lock_guard<std::mutex> lk(g_partsMu);
  auto it = g_parts.find(uid);
  if (it == g_parts.end()) {
    auto state = std::make_unique<ParticipantState>(uid, name);
    state->videoOn = videoOn;
    it = g_parts.emplace(uid, std::move(state)).first;
  } else {
    it->second->present = true;
    it->second->reportedLeft = false;
    if (!name.empty()) it->second->name = name;
  }
  if (g_renderers.count(uid)) return;

  auto* del = new ParticipantVideoDelegate(it->second.get(), g_cfg.frame_max_edge);
  IZoomSDKRenderer* r = nullptr;
  if (createRenderer(&r, del) == SDKERR_SUCCESS && r) {
    // 360p is deliberate. The analyzer downscales to `frame_max_edge` anyway,
    // and subscribing 30 participants at 720p is bandwidth and CPU spent on
    // pixels that are thrown away before anything looks at them.
    r->setRawDataResolution(ZoomSDKResolution_360P);
    r->subscribe(uid, RAW_DATA_TYPE_VIDEO);
    g_renderers[uid] = {r, del};
    std::printf("[bot] subscribed video for user %u (%s)\n", uid, it->second->name.c_str());
  } else {
    // Raw data is gated by Zoom: without local-recording/raw-data approval this
    // is where it fails, and it fails per user rather than at join time.
    std::printf("[bot] createRenderer FAILED for user %u — raw data may not be "
                "authorised for this account\n", uid);
    delete del;
  }
}

void unsubscribeUser(uint32_t uid) {
  std::lock_guard<std::mutex> lk(g_partsMu);
  auto it = g_renderers.find(uid);
  if (it != g_renderers.end()) {
    it->second.second->detach();  // stop the SDK writing into a dying state
    it->second.first->unSubscribe();
    destroyRenderer(it->second.first);
    delete it->second.second;
    g_renderers.erase(it);
  }
  auto p = g_parts.find(uid);
  // The state itself is kept until the analysis loop has reported the leave.
  if (p != g_parts.end()) {
    p->second->present = false;
    p->second->videoOn = false;
  }
}

void unsubscribeAll() {
  std::vector<uint32_t> ids;
  {
    std::lock_guard<std::mutex> lk(g_partsMu);
    for (const auto& kv : g_renderers) ids.push_back(kv.first);
  }
  for (uint32_t id : ids) unsubscribeUser(id);
}

void refreshRoster() {
  if (!g_meeting) return;
  auto* pc = g_meeting->GetMeetingParticipantsController();
  if (!pc) return;
  IList<unsigned int>* users = pc->GetParticipantsList();
  if (!users) return;
  for (int i = 0; i < users->GetCount(); ++i) {
    const uint32_t uid = users->GetItem(i);
    IUserInfo* info = pc->GetUserByUserID(uid);
    if (info && info->IsMySelf()) continue;  // never monitor ourselves
    subscribeUser(uid, info ? (info->GetUserName() ? info->GetUserName() : "") : "",
                  info ? info->IsVideoOn() : false);
    if (info) {
      std::lock_guard<std::mutex> lk(g_partsMu);
      auto it = g_parts.find(uid);
      if (it != g_parts.end()) {
        it->second->audioMuted = info->IsAudioMuted();
        const zchar_t* pid = info->GetPersistentId();
        if (pid) it->second->persistentId = pid;
      }
    }
  }
}

/* ------------------------------------------------------------- SDK events */

class ParticipantsEvent : public IMeetingParticipantsCtrlEvent {
 public:
  void onUserJoin(IList<unsigned int>* lstUserID, const zchar_t*) override {
    if (!lstUserID || !g_meeting) return;
    auto* pc = g_meeting->GetMeetingParticipantsController();
    for (int i = 0; i < lstUserID->GetCount(); ++i) {
      const uint32_t uid = lstUserID->GetItem(i);
      IUserInfo* info = pc ? pc->GetUserByUserID(uid) : nullptr;
      if (info && info->IsMySelf()) continue;
      subscribeUser(uid, info && info->GetUserName() ? info->GetUserName() : "",
                    info ? info->IsVideoOn() : false);
    }
  }

  void onUserLeft(IList<unsigned int>* lstUserID, const zchar_t*) override {
    if (!lstUserID) return;
    for (int i = 0; i < lstUserID->GetCount(); ++i) unsubscribeUser(lstUserID->GetItem(i));
  }

  void onUserNamesChanged(IList<unsigned int>* lstUserID) override {
    if (!lstUserID || !g_meeting) return;
    auto* pc = g_meeting->GetMeetingParticipantsController();
    if (!pc) return;
    std::lock_guard<std::mutex> lk(g_partsMu);
    for (int i = 0; i < lstUserID->GetCount(); ++i) {
      const uint32_t uid = lstUserID->GetItem(i);
      IUserInfo* info = pc->GetUserByUserID(uid);
      auto it = g_parts.find(uid);
      if (it != g_parts.end() && info && info->GetUserName()) it->second->name = info->GetUserName();
    }
  }

  void onHostChangeNotification(unsigned int) override {}
  void onLowOrRaiseHandStatusChanged(bool, unsigned int) override {}
  void onCoHostChangeNotification(unsigned int, bool) override {}
  void onInvalidReclaimHostkey() override {}
  void onAllHandsLowered() override {}
  void onLocalRecordingStatusChanged(unsigned int, RecordingStatus) override {}
  void onAllowParticipantsRenameNotification(bool) override {}
  void onAllowParticipantsUnmuteSelfNotification(bool) override {}
  void onAllowParticipantsStartVideoNotification(bool) override {}
  void onAllowParticipantsShareWhiteBoardNotification(bool) override {}
  void onRequestLocalRecordingPrivilegeChanged(LocalRecordingRequestPrivilegeStatus) override {}
  void onAllowParticipantsRequestCloudRecording(bool) override {}
  void onInMeetingUserAvatarPathUpdated(unsigned int) override {}
  void onParticipantProfilePictureStatusChange(bool) override {}
  void onFocusModeStateChanged(bool) override {}
  void onFocusModeShareTypeChanged(FocusModeShareType) override {}
  void onBotAuthorizerRelationChanged(unsigned int) override {}
  void onVirtualNameTagStatusChanged(bool, unsigned int) override {}
  void onVirtualNameTagRosterInfoUpdated(unsigned int) override {}
  void onGrantCoOwnerPrivilegeChanged(bool) override {}
};

class VideoEvent : public IMeetingVideoCtrlEvent {
 public:
  void onUserVideoStatusChange(unsigned int userId, VideoStatus status) override {
    std::lock_guard<std::mutex> lk(g_partsMu);
    auto it = g_parts.find(userId);
    if (it != g_parts.end()) it->second->videoOn = (status == Video_ON);
  }

  void onSpotlightedUserListChangeNotification(IList<unsigned int>*) override {}
  void onHostRequestStartVideo(IRequestStartVideoHandler*) override {}
  void onActiveSpeakerVideoUserChanged(unsigned int) override {}
  void onActiveVideoUserChanged(unsigned int) override {}
  void onHostVideoOrderUpdated(IList<unsigned int>*) override {}
  void onLocalVideoOrderUpdated(IList<unsigned int>*) override {}
  void onFollowHostVideoOrderChanged(bool) override {}
  void onUserVideoQualityChanged(VideoConnectionQuality, unsigned int) override {}
  void onVideoAlphaChannelStatusChanged(bool) override {}
  void onCameraControlRequestReceived(unsigned int, CameraControlRequestType,
                                      ICameraControlRequestHandler*) override {}
  void onCameraControlRequestResult(unsigned int, CameraControlRequestResult) override {}
};

class AudioEvent : public IMeetingAudioCtrlEvent {
 public:
  void onUserActiveAudioChange(IList<unsigned int>* plstActiveAudio) override {
    std::set<uint32_t> speaking;
    if (plstActiveAudio) {
      for (int i = 0; i < plstActiveAudio->GetCount(); ++i)
        speaking.insert(plstActiveAudio->GetItem(i));
    }
    std::lock_guard<std::mutex> lk(g_partsMu);
    for (auto& kv : g_parts) kv.second->speaking = speaking.count(kv.first) > 0;
  }

  void onUserAudioStatusChange(IList<IUserAudioStatus*>*, const zchar_t*) override {
    // The roster is re-read on the analysis tick; nothing to do here.
  }
  void onHostRequestStartAudio(IRequestStartAudioHandler*) override {}
  void onJoin3rdPartyTelephonyAudio(const zchar_t*) override {}
  void onMuteOnEntryStatusChange(bool) override {}
};

class MeetingEvent : public IMeetingServiceEvent {
 public:
  void onMeetingStatusChanged(MeetingStatus status, int iResult) override {
    std::printf("[bot] meeting status: %d (result %d)\n", status, iResult);
    if (status == MEETING_STATUS_INMEETING) {
      g_inMeeting = true;
      g_joining = false;
      if (g_meeting) {
        if (auto* pc = g_meeting->GetMeetingParticipantsController()) pc->SetEvent(&participants_);
        if (auto* vc = g_meeting->GetMeetingVideoController()) vc->SetEvent(&video_);
        if (auto* ac = g_meeting->GetMeetingAudioController()) ac->SetEvent(&audio_);
      }
      refreshRoster();
    } else if (status == MEETING_STATUS_ENDED || status == MEETING_STATUS_FAILED ||
               status == MEETING_STATUS_DISCONNECTING) {
      if (g_inMeeting.exchange(false)) {
        std::printf("[bot] left the meeting\n");
        unsubscribeAll();
      }
      g_joining = false;
    }
  }

  void onMeetingStatisticsWarningNotification(StatisticsWarningType) override {}
  void onMeetingParameterNotification(const MeetingParameter*) override {}
  void onSuspendParticipantsActivities() override {}
  void onAICompanionActiveChangeNotice(bool) override {}
  void onMeetingTopicChanged(const zchar_t*) override {}
  void onMeetingFullToWatchLiveStream(const zchar_t*) override {}
  void onUserNetworkStatusChanged(MeetingComponentType, ConnectionQuality, unsigned int,
                                  bool) override {}

 private:
  ParticipantsEvent participants_;
  VideoEvent video_;
  AudioEvent audio_;
};

MeetingEvent g_meetingEv;

/* --------------------------------------------------------------- joining */

/** Runs on the glib thread (via g_idle_add). */
gboolean doJoin(gpointer) {
  if (!g_authed || g_inMeeting || g_joining) return G_SOURCE_REMOVE;

  Assignment a;
  {
    std::lock_guard<std::mutex> lk(g_assignMu);
    a = g_assignment;
  }
  if (a.meetingId.empty()) return G_SOURCE_REMOVE;

  if (!g_meeting) {
    CreateMeetingService(&g_meeting);
    if (!g_meeting) {
      std::fprintf(stderr, "[bot] CreateMeetingService failed\n");
      return G_SOURCE_REMOVE;
    }
    g_meeting->SetEvent(&g_meetingEv);
  }

  g_joining = true;
  std::printf("[bot] joining meeting %s (%s)\n", a.meetingId.c_str(), a.topic.c_str());

  JoinParam jp;
  jp.userType = SDK_UT_WITHOUT_LOGIN;
  auto& p = jp.param.withoutloginuserJoin;
  std::memset(&p, 0, sizeof(p));
  p.meetingNumber = std::strtoull(a.meetingId.c_str(), nullptr, 10);
  p.userName = g_cfg.display_name.c_str();
  p.psw = a.passcode.empty() ? nullptr : a.passcode.c_str();
  p.vanityID = nullptr;
  p.customer_key = nullptr;
  p.webinarToken = nullptr;
  p.isVideoOff = true;  // the bot itself contributes no video or audio
  p.isAudioOff = true;
  if (!g_cfg.join_token.empty()) p.join_token = g_cfg.join_token.c_str();

  const SDKError err = g_meeting->Join(jp);
  if (err != SDKERR_SUCCESS) {
    std::fprintf(stderr, "[bot] Join failed: %d\n", err);
    g_joining = false;
  }
  return G_SOURCE_REMOVE;
}

gboolean doLeave(gpointer) {
  if (g_meeting && g_inMeeting) {
    unsubscribeAll();
    g_meeting->Leave(LEAVE_MEETING);
  }
  return G_SOURCE_REMOVE;
}

/* -------------------------------------------------------------- analysis */

/** Builds one observation for a participant, or nothing if it is not due. */
bool buildObservation(ParticipantState& st, const Assignment& a, json* out) {
  const bool wantSnapshot = a.snapshotsEnabled && g_cfg.snapshot_interval_sec > 0 &&
                            secondsSince(st.lastSnapshot) >= g_cfg.snapshot_interval_sec;

  json o{
      {"zoomUserId", std::to_string(st.userId)},
      {"zoomUserName", st.name},
      {"observedAt", nowMs()},
      {"microphoneOn", !st.audioMuted.load()},
      {"speaking", st.speaking.load()},
  };
  if (!st.persistentId.empty()) o["zoomParticipantUuid"] = st.persistentId;

  // A participant who has left is reported once and then forgotten.
  if (!st.present) {
    o["left"] = true;
    o["faceDetected"] = false;
    o["faceCount"] = 0;
    o["cameraOn"] = false;
    *out = std::move(o);
    return true;
  }

  I420Frame frame;
  Clock::time_point frameAt;
  const bool haveFrame = st.latestFrame(&frame, &frameAt);
  const bool stale = !haveFrame || secondsSince(frameAt) > g_cfg.video_stall_sec;

  // Camera off, or video that stopped arriving. Either way there is nothing to
  // analyse, and saying so is itself a signal the console acts on.
  if (!st.videoOn || stale) {
    o["cameraOn"] = false;
    o["faceDetected"] = false;
    o["faceCount"] = 0;
    // Identity is not asserted from a frame we do not have.
    o["identityStatus"] = "UNKNOWN";
    *out = std::move(o);
    return true;
  }

  const std::string b64 = yuvjpeg::encodeI420(frame.y.data(), frame.u.data(), frame.v.data(),
                                              frame.width, frame.height, g_cfg.jpeg_quality);
  if (b64.empty()) return false;  // transient encode failure: skip this round

  const bool identify = a.identityEnabled && secondsSince(st.lastIdentified) >= g_cfg.reauth_interval_sec;
  const json r = g_analyzer->analyze(b64, identify);
  if (!r.value("ok", false)) {
    std::fprintf(stderr, "[bot] analyzer error for user %u: %s\n", st.userId,
                 r.value("error", std::string("unknown")).c_str());
    return false;
  }

  const int faceCount = r.value("faceCount", 0);
  o["cameraOn"] = true;
  o["faceCount"] = faceCount;
  o["faceDetected"] = faceCount > 0;

  if (faceCount > 0 && r.contains("primary") && !r["primary"].is_null()) {
    const auto& p = r["primary"];
    o["faceBox"] = p.value("box", json::object());
    o["yaw"] = p.value("yaw", 0.0);
    o["pitch"] = p.value("pitch", 0.0);
    o["roll"] = p.value("roll", 0.0);
    o["eyeClosed"] = p.value("eyeClosed", false);
    o["eyeOpenness"] = p.value("eyeOpenness", 0.0);
  }

  if (identify && r.contains("identity") && !r["identity"].is_null()) {
    const auto& id = r["identity"];
    const std::string status = id.value("status", "UNAVAILABLE");
    st.lastIdentified = Clock::now();
    if (status == "MATCH") {
      st.traineeId = id.value("traineeId", std::string());
      st.identityConfidence = id.value("confidence", 0.0);
    } else if (status == "NO_MATCH") {
      st.traineeId.clear();
      st.identityConfidence = id.value("confidence", 0.0);
    }
    // UNAVAILABLE (engine down) deliberately leaves the previous identity in
    // place: an unreachable engine is not evidence that someone is an impostor.
  }

  if (faceCount == 0) {
    o["identityStatus"] = "NO_FACE";
  } else if (faceCount > 1) {
    o["identityStatus"] = "MULTIPLE_FACES";
  } else if (!st.traineeId.empty()) {
    o["identityStatus"] = "VERIFIED";
    o["traineeId"] = st.traineeId;
    o["identityConfidence"] = st.identityConfidence;
  } else if (a.identityEnabled) {
    o["identityStatus"] = "UNVERIFIED";
    if (st.identityConfidence > 0) o["identityConfidence"] = st.identityConfidence;
  } else {
    o["identityStatus"] = "UNKNOWN";
  }

  if (wantSnapshot) {
    o["snapshot"] = yuvjpeg::dataUrl(b64);
    st.lastSnapshot = Clock::now();
  }

  *out = std::move(o);
  return true;
}

void analysisLoop() {
  while (!g_stop) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    if (!g_inMeeting) continue;

    Assignment a;
    {
      std::lock_guard<std::mutex> lk(g_assignMu);
      a = g_assignment;
    }
    if (a.meetingId.empty()) continue;

    // Snapshot the set of participants due for analysis, then release the lock:
    // analysing one participant takes tens of milliseconds and must not block
    // the SDK callbacks that add and remove them.
    std::vector<ParticipantState*> due;
    std::vector<uint32_t> finished;
    {
      std::lock_guard<std::mutex> lk(g_partsMu);
      for (auto& kv : g_parts) {
        ParticipantState& st = *kv.second;
        if (!st.present && st.reportedLeft) {
          finished.push_back(kv.first);
          continue;
        }
        const double interval = st.present ? a.observeIntervalSec : 0;
        if (secondsSince(st.lastObserved) >= interval) due.push_back(&st);
      }
      for (uint32_t id : finished) g_parts.erase(id);
    }

    json observations = json::array();
    for (ParticipantState* st : due) {
      json o;
      if (!buildObservation(*st, a, &o)) continue;
      st->lastObserved = Clock::now();
      if (!st->present) st->reportedLeft = true;
      observations.push_back(std::move(o));
      // The endpoint caps a batch at 200; flush early so a very large meeting
      // still reports promptly instead of being rejected wholesale.
      if (observations.size() >= 50) {
        std::string body;
        const long code = g_backend->observe(a.meetingId, a.organizationId, observations, &body);
        if (code != 200)
          std::fprintf(stderr, "[bot] observe HTTP %ld: %s\n", code, body.substr(0, 300).c_str());
        observations = json::array();
      }
    }

    if (!observations.empty()) {
      std::string body;
      const long code = g_backend->observe(a.meetingId, a.organizationId, observations, &body);
      if (code != 200)
        std::fprintf(stderr, "[bot] observe HTTP %ld: %s\n", code, body.substr(0, 300).c_str());
    }
  }
}

/* ------------------------------------------------------------ assignments */

void assignmentLoop() {
  while (!g_stop) {
    std::string error;
    const json list = g_backend->assignments(&error);
    if (!error.empty()) std::fprintf(stderr, "[bot] assignments: %s\n", error.c_str());

    std::string currentId;
    {
      std::lock_guard<std::mutex> lk(g_assignMu);
      currentId = g_assignment.meetingId;
    }

    // One meeting at a time: a single SDK instance can only be in one.
    // The first live meeting wins, and the rest wait for it to end.
    const json* chosen = nullptr;
    for (const auto& item : list) {
      if (!currentId.empty() && item.value("meetingId", std::string()) == currentId) {
        chosen = &item;
        break;
      }
      if (!chosen) chosen = &item;
    }

    if (!chosen) {
      if (!currentId.empty()) {
        std::printf("[bot] no live meetings; leaving %s\n", currentId.c_str());
        {
          std::lock_guard<std::mutex> lk(g_assignMu);
          g_assignment = Assignment{};
        }
        g_idle_add(doLeave, nullptr);
      }
    } else {
      Assignment a;
      a.meetingId = chosen->value("meetingId", std::string());
      a.organizationId = chosen->value("organizationId", std::string());
      a.passcode = chosen->contains("passcode") && !(*chosen)["passcode"].is_null()
                       ? chosen->value("passcode", std::string())
                       : "";
      a.topic = chosen->value("topic", std::string());
      a.observeIntervalSec = chosen->value("observeIntervalSec", 10);
      a.snapshotsEnabled = chosen->value("snapshotsEnabled", false);
      a.identityEnabled = chosen->value("identityEnabled", true);

      const bool changed = a.meetingId != currentId;
      {
        std::lock_guard<std::mutex> lk(g_assignMu);
        g_assignment = a;
      }
      if (changed && g_inMeeting) {
        g_idle_add(doLeave, nullptr);
      } else if (!g_inMeeting && !g_joining && g_authed) {
        g_idle_add(doJoin, nullptr);
      }
    }

    for (int i = 0; i < g_cfg.assignment_poll_sec && !g_stop; ++i)
      std::this_thread::sleep_for(std::chrono::seconds(1));
  }
}

/** Pinned mode: no polling, just keep trying to be in the configured meeting. */
void pinnedLoop() {
  while (!g_stop) {
    if (g_authed && !g_inMeeting && !g_joining) g_idle_add(doJoin, nullptr);
    for (int i = 0; i < 10 && !g_stop; ++i) std::this_thread::sleep_for(std::chrono::seconds(1));
  }
}

/* ------------------------------------------------------------------- auth */

class AuthEvent : public IAuthServiceEvent {
 public:
  void onAuthenticationReturn(AuthResult ret) override {
    if (ret != AUTHRET_SUCCESS) {
      std::fprintf(stderr,
                   "[bot] SDK authentication failed: %d "
                   "(check ZOOM_SDK_KEY / ZOOM_SDK_SECRET)\n", ret);
      return;
    }
    std::printf("[bot] authenticated with the Meeting SDK\n");
    g_authed = true;
  }
  void onLoginReturnWithReason(LOGINSTATUS, IAccountInfo*, LoginFailReason) override {}
  void onLogout() override {}
  void onZoomIdentityExpired() override {}
  void onZoomAuthIdentityExpired() override {}
};

AuthEvent g_authEv;
GMainLoop* g_loop = nullptr;

void onSignal(int) {
  g_stop = true;
  if (g_loop) g_main_loop_quit(g_loop);
}

}  // namespace

int main(int argc, char** argv) {
  (void)argc;
  (void)argv;

  g_cfg = Config::fromEnv();
  if (!g_cfg.valid()) {
    std::fprintf(stderr,
                 "missing config. Required: ZOOM_SDK_KEY ZOOM_SDK_SECRET ZOOMER_BASE_URL "
                 "BOT_INGEST_TOKEN\n"
                 "Optional: ZOOM_MEETING_NUMBER (pin to one meeting; then "
                 "ZOOMER_ORGANIZATION_ID is required too)\n");
    return 2;
  }
  if (g_cfg.pinned() && g_cfg.organization_id.empty()) {
    std::fprintf(stderr,
                 "ZOOM_MEETING_NUMBER is set but ZOOMER_ORGANIZATION_ID is not. A pinned "
                 "meeting cannot be attributed to a customer without it.\n");
    return 2;
  }

  g_analyzer = new AnalyzerClient(g_cfg.analyzer_host, g_cfg.analyzer_port);
  g_backend = new BackendClient(g_cfg.zoomer_base_url, g_cfg.bot_ingest_token);

  if (!g_analyzer->ping()) {
    std::fprintf(stderr,
                 "[bot] WARNING: analysis sidecar unreachable at %s:%d — observations will "
                 "carry no face data until it is up\n",
                 g_cfg.analyzer_host.c_str(), g_cfg.analyzer_port);
  }

  InitParam ip;
  ip.strWebDomain = "https://zoom.us";
  ip.enableLogByDefault = true;
  if (InitSDK(ip) != SDKERR_SUCCESS) {
    std::fprintf(stderr, "InitSDK failed\n");
    return 1;
  }

  CreateAuthService(&g_auth);
  if (!g_auth) {
    std::fprintf(stderr, "CreateAuthService failed\n");
    return 1;
  }
  g_auth->SetEvent(&g_authEv);

  const std::string token = jwt::meetingSdkToken(g_cfg.sdk_key, g_cfg.sdk_secret);
  AuthContext ac;
  ac.jwt_token = token.c_str();
  if (g_auth->SDKAuth(ac) != SDKERR_SUCCESS) {
    std::fprintf(stderr, "SDKAuth call failed\n");
    return 1;
  }

  std::signal(SIGINT, onSignal);
  std::signal(SIGTERM, onSignal);

  std::thread analysis(analysisLoop);
  std::thread work(g_cfg.pinned() ? pinnedLoop : assignmentLoop);

  if (g_cfg.pinned()) {
    std::lock_guard<std::mutex> lk(g_assignMu);
    g_assignment.meetingId = g_cfg.meeting_number;
    g_assignment.organizationId = g_cfg.organization_id;
    g_assignment.passcode = g_cfg.passcode;
    g_assignment.observeIntervalSec = g_cfg.observe_interval_sec;
    // Pinned mode has no backend-supplied settings, so snapshots follow the
    // bot's own configuration.
    g_assignment.snapshotsEnabled = g_cfg.snapshot_interval_sec > 0;
  }

  std::printf("[bot] running (%s). Ctrl-C to stop.\n",
              g_cfg.pinned() ? "pinned meeting" : "assignment polling");

  // The Linux Meeting SDK is driven by a glib main loop; every callback above
  // is delivered on this thread.
  g_loop = g_main_loop_new(nullptr, FALSE);
  g_main_loop_run(g_loop);

  g_stop = true;
  analysis.join();
  work.join();
  unsubscribeAll();
  if (g_meeting) g_meeting->Leave(LEAVE_MEETING);
  CleanUPSDK();
  return 0;
}
