import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  Activity, Bell, CalendarDays, FileBarChart2, FileCheck2, LayoutDashboard, LogOut, Menu, Moon,
  Settings as SettingsIcon, Sun, UserPlus, Users, Video,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarHeader,
  SidebarInset, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger,
} from "@/components/ui/sidebar";
import { useAuth } from "@/lib/auth-context";
import { Logo } from "./primitives";

/**
 * The original six destinations from the approved mockup, plus the four
 * organizer-console pages. Nothing was removed or renamed: an operator who
 * knows the old navigation finds every item exactly where it was.
 */
const NAV = [
  { to: "/", label: "ダッシュボード", icon: LayoutDashboard, end: true },
  { to: "/live", label: "ライブ会議", icon: Activity },
  { to: "/participants", label: "参加者", icon: Users },
  { to: "/events", label: "イベント", icon: Bell },
  { to: "/reports", label: "レポート", icon: FileBarChart2 },
  { to: "/monitor", label: "ライブ監視", icon: Video },
  { to: "/sessions", label: "研修管理", icon: CalendarDays },
  { to: "/enroll", label: "受講者登録", icon: UserPlus },
  { to: "/logs", label: "証跡・ログ", icon: FileCheck2 },
  { to: "/settings", label: "設定", icon: SettingsIcon },
];

const HEADINGS: { match: (p: string) => boolean; title: string; subtitle: string }[] = [
  { match: (p) => p === "/", title: "ダッシュボード", subtitle: "本日の研修状況と重要イベント" },
  { match: (p) => p.startsWith("/live"), title: "ライブ会議", subtitle: "Zoom会議の参加者状況をリアルタイムに把握" },
  { match: (p) => p.startsWith("/participants"), title: "参加者", subtitle: "参加者ごとの観測状態と本人確認" },
  { match: (p) => p.startsWith("/events"), title: "イベント", subtitle: "検知イベントの発生から解消まで" },
  { match: (p) => p.startsWith("/reports"), title: "レポート", subtitle: "会議終了後の参加状況サマリーと出力" },
  { match: (p) => p.startsWith("/monitor"), title: "ライブ監視", subtitle: "Zoom研修の受講状況をリアルタイム監視" },
  { match: (p) => p.startsWith("/sessions"), title: "研修管理", subtitle: "研修の作成・参加者割当・Zoom連携" },
  { match: (p) => p.startsWith("/enroll"), title: "受講者登録", subtitle: "本人確認用の顔画像と受講者情報を管理" },
  { match: (p) => p.startsWith("/logs"), title: "証跡・ログ", subtitle: "監視イベントと保存画像を検索・出力" },
  { match: (p) => p.startsWith("/settings"), title: "設定", subtitle: "検知ルール・通知・証跡保存を構成" },
];

const ROLE_LABELS: Record<string, string> = {
  sys_admin: "システム管理者",
  training_admin: "研修管理者",
  auditor: "監査担当者",
};

export function AppShell({
  children,
  alertCount = 0,
  onOpenAlerts,
}: {
  children: ReactNode;
  alertCount?: number;
  onOpenAlerts?: () => void;
}) {
  const { pathname } = useLocation();
  const { user, logout } = useAuth();
  const [dark, setDark] = useState(() => localStorage.getItem("zoomer-theme") === "dark");

  useEffect(() => {
    localStorage.setItem("zoomer-theme", dark ? "dark" : "light");
  }, [dark]);

  const heading = HEADINGS.find((h) => h.match(pathname)) ?? HEADINGS[0];

  return (
    <div className={`zoomer-shell ${dark ? "dark" : ""}`}>
      <SidebarProvider>
        <Sidebar className="border-none">
          <SidebarHeader className="px-4 py-5">
            <Logo />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.map((item) => (
                    <SidebarMenuItem key={item.to}>
                      <NavLink to={item.to} end={item.end}>
                        {({ isActive }) => (
                          <SidebarMenuButton isActive={isActive} className="gap-3 py-5 font-semibold">
                            <item.icon />
                            <span>{item.label}</span>
                          </SidebarMenuButton>
                        )}
                      </NavLink>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter className="gap-2 px-4 py-4">
            {user && (
              <div className="rounded-xl bg-white/10 px-3 py-2.5 text-sidebar-foreground">
                <div className="truncate text-sm font-bold">{user.name}</div>
                <div className="mt-0.5 truncate text-xs opacity-75">
                  {ROLE_LABELS[user.role] ?? user.role}
                </div>
              </div>
            )}
            <Button
              variant="ghost"
              className="justify-start gap-2 text-sidebar-foreground hover:bg-white/10 hover:text-white"
              onClick={() => void logout()}
            >
              <LogOut className="size-4" />
              ログアウト
            </Button>
          </SidebarFooter>
        </Sidebar>

        <SidebarInset className="bg-transparent">
          <header className="sticky top-0 z-20 flex min-h-[78px] items-center justify-between border-b border-slate-200/80 bg-white/88 px-4 backdrop-blur-xl sm:px-7">
            <div className="flex min-w-0 items-center gap-3">
              <SidebarTrigger className="md:hidden" aria-label="メニューを開く">
                <Menu />
              </SidebarTrigger>
              <div className="min-w-0">
                <h1 className="truncate text-xl font-bold tracking-tight text-slate-950 sm:text-2xl">
                  {heading.title}
                </h1>
                <p className="mt-0.5 hidden text-sm text-slate-500 sm:block">{heading.subtitle}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="hidden items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-semibold text-emerald-700 lg:flex">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                システム正常
              </div>
              <Button
                variant="outline"
                size="icon"
                className="relative rounded-xl border-slate-200"
                onClick={onOpenAlerts}
                aria-label={`通知を表示（${alertCount}件）`}
              >
                <Bell />
                {alertCount > 0 && (
                  <span className="absolute -right-1 -top-1 grid h-5 w-5 place-items-center rounded-full bg-rose-500 text-[0.65rem] font-bold text-white">
                    {alertCount > 99 ? "99+" : alertCount}
                  </span>
                )}
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="rounded-xl border-slate-200"
                onClick={() => setDark((v) => !v)}
                aria-label={dark ? "ライト表示に切り替え" : "ダーク表示に切り替え"}
              >
                {dark ? <Sun /> : <Moon />}
              </Button>
            </div>
          </header>

          <main className="space-y-5 p-4 sm:p-7">{children}</main>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
