// Zoomer Meeting Bot — SDK lifecycle: init → auth (JWT) → join → per-participant
// raw video → engine → ingest. This file wires the confirmed 7.1.5 interfaces;
// spots that vary by SDK point-release are marked TODO(sdk) — verify against h/.
#include "zoom_sdk.h"
#include "auth_service_interface.h"
#include "meeting_service_interface.h"
#include "meeting_service_components/meeting_audio_interface.h"  // defines AudioType (used by participants ctrl)
#include "meeting_service_components/meeting_participants_ctrl_interface.h"
#include "rawdata/zoom_rawdata_api.h"

#include "config.hpp"
#include "engine_client.hpp"
#include "ingest_client.hpp"
#include "jwt.hpp"
#include "video_delegate.hpp"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <map>
#include <thread>

using namespace ZOOMSDK;

namespace {
Config g_cfg;
EngineClient* g_engine = nullptr;
IngestClient* g_ingest = nullptr;
EventSink g_sink;
IMeetingService* g_meeting = nullptr;
std::atomic<bool> g_inMeeting{false};
std::map<uint32_t, std::pair<IZoomSDKRenderer*, ParticipantVideoDelegate*>> g_renderers;

void subscribeUser(uint32_t uid, const std::string& name) {
  if (g_renderers.count(uid)) return;
  auto* del = new ParticipantVideoDelegate(uid, name, g_engine, &g_sink, g_cfg);
  IZoomSDKRenderer* r = nullptr;
  if (createRenderer(&r, del) == SDKERR_SUCCESS && r) {
    r->setRawDataResolution(ZoomSDKResolution_720P);   // TODO(sdk): pick per cost
    r->subscribe(uid, RAW_DATA_TYPE_VIDEO);
    g_renderers[uid] = {r, del};
    std::printf("[bot] subscribed video for user %u (%s)\n", uid, name.c_str());
  } else {
    delete del;
  }
}

void unsubscribeUser(uint32_t uid) {
  auto it = g_renderers.find(uid);
  if (it == g_renderers.end()) return;
  it->second.first->unSubscribe();
  destroyRenderer(it->second.first);
  delete it->second.second;
  g_renderers.erase(it);
}

// --- Auth callback ---
class AuthEvent : public IAuthServiceEvent {
 public:
  void onAuthenticationReturn(AuthResult ret) override {
    if (ret != AUTHRET_SUCCESS) {
      std::printf("[bot] auth failed: %d\n", ret);
      return;
    }
    std::printf("[bot] authenticated; joining meeting %s\n", g_cfg.meeting_number.c_str());
    CreateMeetingService(&g_meeting);
    // g_meeting->SetEvent(new MeetingEvent());   // set below in main
    JoinParam jp;
    jp.userType = SDK_UT_WITHOUT_LOGIN;
    auto& p = jp.param.withoutloginuserJoin;      // TODO(sdk): confirm field names
    p.meetingNumber = std::strtoull(g_cfg.meeting_number.c_str(), nullptr, 10);
    p.userName = g_cfg.display_name.c_str();
    p.psw = g_cfg.passcode.c_str();
    p.vanityID = nullptr;
    p.customer_key = nullptr;
    p.webinarToken = nullptr;
    p.isVideoOff = true;   // the bot itself sends no video
    p.isAudioOff = true;
    if (!g_cfg.join_token.empty()) p.join_token = g_cfg.join_token.c_str();
    g_meeting->Join(jp);
  }
  void onLoginReturnWithReason(LOGINSTATUS, IAccountInfo*, LoginFailReason) override {}
  void onLogout() override {}
  void onZoomIdentityExpired() override {}
  void onZoomAuthIdentityExpired() override {}
};

// --- Meeting status + participant callbacks ---
class MeetingEvent : public IMeetingServiceEvent {
 public:
  void onMeetingStatusChanged(MeetingStatus status, int) override {
    std::printf("[bot] meeting status: %d\n", status);
    if (status == MEETING_STATUS_INMEETING) {
      g_inMeeting = true;
      auto* pc = g_meeting->GetMeetingParticipantsController();
      if (!pc) return;
      IList<unsigned int>* users = pc->GetParticipantsList();
      for (int i = 0; users && i < users->GetCount(); ++i) {
        uint32_t uid = users->GetItem(i);
        IUserInfo* info = pc->GetUserByUserID(uid);
        subscribeUser(uid, info ? info->GetUserName() : "");
      }
    } else if (status == MEETING_STATUS_ENDED || status == MEETING_STATUS_FAILED) {
      g_inMeeting = false;
    }
  }
  void onMeetingStatisticsWarningNotification(StatisticsWarningType) override {}
  void onMeetingParameterNotification(const MeetingParameter*) override {}
  void onSuspendParticipantsActivities() override {}
  void onAICompanionActiveChangeNotice(bool) override {}
  void onMeetingTopicChanged(const zchar_t*) override {}
  void onMeetingFullToWatchLiveStream(const zchar_t*) override {}
  void onUserNetworkStatusChanged(MeetingComponentType, ConnectionQuality, unsigned int, bool) override {}
  // TODO(sdk): also register IMeetingParticipantsCtrlEvent (onUserJoin/onUserLeft)
  // via GetMeetingParticipantsController()->SetEvent(...) to add/remove renderers live.
};

// Flush queued events to Zoomer every second.
void ingestLoop() {
  while (true) {
    std::this_thread::sleep_for(std::chrono::seconds(1));
    auto batch = g_sink.drain();
    if (batch.empty()) continue;
    std::string body;
    long code = g_ingest->post(g_cfg.meeting_number, batch, &body);
    if (code != 200) std::printf("[bot] ingest HTTP %ld: %s\n", code, body.c_str());
  }
}
}  // namespace

int main(int argc, char** argv) {
  (void)argc; (void)argv;
  g_cfg = Config::fromEnv();
  if (!g_cfg.valid()) {
    std::fprintf(stderr,
                 "missing config. Required env: ZOOM_SDK_KEY ZOOM_SDK_SECRET ZOOM_MEETING_NUMBER "
                 "ZOOMER_BASE_URL BOT_INGEST_TOKEN\n");
    return 2;
  }
  g_engine = new EngineClient(g_cfg.engine_host, g_cfg.engine_port);
  g_ingest = new IngestClient(g_cfg.zoomer_base_url, g_cfg.bot_ingest_token);

  InitParam ip;
  ip.strWebDomain = "https://zoom.us";
  if (InitSDK(ip) != SDKERR_SUCCESS) { std::fprintf(stderr, "InitSDK failed\n"); return 1; }

  IAuthService* auth = nullptr;
  CreateAuthService(&auth);
  static AuthEvent authEv;
  static MeetingEvent meetingEv;
  auth->SetEvent(&authEv);

  const std::string token = jwt::meetingSdkToken(g_cfg.sdk_key, g_cfg.sdk_secret);
  AuthContext ac;
  ac.jwt_token = token.c_str();
  auth->SDKAuth(ac);

  std::thread(ingestLoop).detach();

  // The Linux SDK is driven by a glib main loop; auth/meeting callbacks fire on it.
  // TODO(sdk): g_main_loop_run(g_main_loop_new(nullptr, FALSE));
  // (Set g_meeting->SetEvent(&meetingEv) inside AuthEvent right after CreateMeetingService.)
  (void)meetingEv;
  std::printf("[bot] running. Ctrl-C to stop.\n");
  for (;;) std::this_thread::sleep_for(std::chrono::seconds(3600));
  CleanUPSDK();
  return 0;
}
