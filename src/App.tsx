import { Navigate, Route, Routes } from "react-router-dom";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/shell/AppShell";
import { useAuth } from "@/lib/auth-context";
import { api } from "@/lib/api";
import { LoginScreen } from "@/screens/Login";
import { DashboardScreen } from "@/screens/admin/Dashboard";
import { MonitorScreen } from "@/screens/admin/Monitor";
import { LiveMeetingScreen } from "@/screens/admin/LiveMeeting";
import { MeetingParticipantsScreen } from "@/screens/admin/MeetingParticipants";
import { MeetingEventsScreen } from "@/screens/admin/MeetingEvents";
import { MeetingReportsScreen } from "@/screens/admin/MeetingReports";
import { SessionsScreen } from "@/screens/admin/Sessions";
import { EnrollScreen } from "@/screens/admin/Enroll";
import { LogsScreen } from "@/screens/admin/Logs";
import { SettingsScreen } from "@/screens/admin/Settings";
import { TraineeJoinScreen } from "@/screens/trainee/Join";

function AdminArea() {
  const [alertCount, setAlertCount] = useState(0);

  useEffect(() => {
    const load = () =>
      api
        .listAlerts({ state: "OPEN" })
        .then((r) => setAlertCount(r.alerts.length))
        .catch(() => setAlertCount(0));
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
    <AppShell alertCount={alertCount}>
      <Routes>
        <Route index element={<DashboardScreen />} />
        <Route path="monitor" element={<MonitorScreen />} />
        {/* Zoom Organizer Intelligence layer (additive; /monitor is unchanged). */}
        <Route path="live" element={<LiveMeetingScreen />} />
        <Route path="participants" element={<MeetingParticipantsScreen />} />
        <Route path="events" element={<MeetingEventsScreen />} />
        <Route path="reports" element={<MeetingReportsScreen />} />
        <Route path="sessions" element={<SessionsScreen />} />
        <Route path="enroll" element={<EnrollScreen />} />
        <Route path="logs" element={<LogsScreen />} />
        <Route path="settings" element={<SettingsScreen />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AppShell>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      {/* Trainee route is intentionally outside the admin session guard: it is
          authenticated by its own per-participant join token. */}
      <Route path="/join/:participantId" element={<TraineeJoinScreen />} />
      <Route
        path="/*"
        element={
          loading ? (
            <div className="grid min-h-screen place-items-center bg-[#f4f7fb]">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-slate-200 border-t-cyan-500" />
            </div>
          ) : user ? (
            <AdminArea />
          ) : (
            <LoginScreen />
          )
        }
      />
    </Routes>
  );
}
