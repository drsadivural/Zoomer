/**
 * Why the console is empty.
 *
 * Getting a live Zoom meeting onto this screen depends on a chain: OAuth
 * connected, the right scopes granted, the event subscription configured and
 * actually delivering, a session linked to the meeting. Any one link missing
 * produces the identical symptom — a blank grid with nothing to act on — and
 * the difference between "nobody has joined yet" and "Zoom has never been able
 * to tell us anything" is invisible from the page.
 *
 * So the page says which link is broken. Shown only when there is nothing to
 * display; when participants are present it stays out of the way.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { api, type ZoomDiagnostics } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

type Level = "ok" | "warn" | "bad";

interface Step {
  level: Level;
  title: string;
  detail: string;
  /** What the operator has to do, when it is not something the app can fix. */
  action?: string;
}

/** Turns the raw report into the ordered chain of setup steps. */
export function readinessSteps(d: ZoomDiagnostics): Step[] {
  const steps: Step[] = [];

  steps.push(
    d.connected
      ? {
          level: "ok",
          title: "Zoomアカウント連携",
          detail: d.connectedAt ? `${formatDateTime(d.connectedAt)} に接続` : "接続済み",
        }
      : {
          level: "bad",
          title: "Zoomアカウント未連携",
          detail: "Zoomと接続されていません。",
          action: "設定 → Zoomアカウントを接続",
        },
  );
  // Deliberately not returning early when disconnected. An administrator
  // setting this up wants the whole checklist in front of them — the scopes to
  // add and the webhook URL to paste are needed whether or not the first step
  // is done yet, and revealing them one round-trip at a time is how a setup
  // takes a week.
  if (!d.connected) {
    steps.push({
      level: "warn",
      title: "Zoomの権限（スコープ）",
      detail: `接続後に確認します。必要: ${d.scopes.required.join(", ")}`,
    });
    steps.push({
      level: "warn",
      title: "Zoomイベント受信",
      detail:
        d.webhooks.received > 0
          ? `${d.webhooks.received}件受信済み`
          : "未受信。参加者の入退室はZoomのWebhookで届きます。",
      action: `Zoom Marketplace → Feature → Event Subscription に ${d.webhooks.url} を登録し、meeting.started / meeting.ended / meeting.participant_joined / meeting.participant_left を購読してください`,
    });
    return steps;
  }

  if (d.scopes.missing.length) {
    steps.push({
      level: "bad",
      title: "Zoomの権限（スコープ）が不足しています",
      detail: `未付与: ${d.scopes.missing.join(", ")}`,
      action:
        "Zoom Marketplace → あなたのアプリ → Scopes で上記を追加し、設定から接続し直してください",
    });
  } else {
    steps.push({ level: "ok", title: "Zoomの権限", detail: "必要なスコープはすべて付与されています" });
  }

  steps.push(
    d.liveMeetings.ok
      ? {
          level: d.liveMeetings.count ? "ok" : "warn",
          title: "開催中のZoomミーティング",
          detail: d.liveMeetings.count
            ? `${d.liveMeetings.count}件`
            : "現在開催中のミーティングはありません。Zoomで開始すると表示されます。",
        }
      : {
          level: "bad",
          title: "Zoom APIを呼び出せません",
          detail: d.liveMeetings.error ?? "不明なエラー",
        },
  );

  steps.push(
    d.webhooks.received > 0
      ? {
          level: "ok",
          title: "Zoomイベント受信",
          detail: `${d.webhooks.received}件受信（最終 ${
            d.webhooks.lastAt ? formatDateTime(d.webhooks.lastAt) : "—"
          }）`,
        }
      : {
          level: "bad",
          title: "Zoomイベントを一度も受信していません",
          detail:
            "参加者の入退室はZoomのWebhookで届きます。Event Subscriptionが未設定か、未検証の可能性があります。",
          action: `Zoom Marketplace → Feature → Event Subscription に ${d.webhooks.url} を登録し、meeting.started / meeting.ended / meeting.participant_joined / meeting.participant_left を購読してください`,
        },
  );

  if (d.sessions.total === 0) {
    steps.push({
      level: "warn",
      title: "研修がありません",
      detail: "Zoomミーティングの開始を検知すると自動作成されます（設定で無効化可能）。",
    });
  } else if (d.sessions.linkedToZoom === 0) {
    steps.push({
      level: "warn",
      title: "Zoomミーティングに紐付いた研修がありません",
      detail: `研修 ${d.sessions.total}件のうち、Zoomミーティングid が設定されているものはありません。`,
      action: "研修管理で会議IDを設定するか、Zoom側で会議を開始してください",
    });
  } else {
    steps.push({
      level: "ok",
      title: "研修とZoomの紐付け",
      detail: `${d.sessions.linkedToZoom}件が紐付け済み・開催中 ${d.sessions.live}件`,
    });
  }

  return steps;
}

const ICONS: Record<Level, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  bad: XCircle,
};
const TONES: Record<Level, string> = {
  ok: "text-emerald-600",
  warn: "text-amber-600",
  bad: "text-rose-600",
};

export function ZoomReadiness() {
  const [data, setData] = useState<ZoomDiagnostics | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .zoomDiagnostics()
      .then((d) => active && setData(d))
      // A reader without settings:read simply does not get the checklist;
      // that is not worth an error banner on a monitoring screen.
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, []);

  if (failed) return null;
  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-500">
        <Loader2 className="size-4 animate-spin" />
        Zoom連携の状態を確認しています…
      </div>
    );
  }

  const steps = readinessSteps(data);
  return (
    <div className="mx-5 mb-5 rounded-xl border border-slate-200 bg-slate-50/70 p-4">
      <p className="mb-3 text-sm font-bold text-slate-800">Zoom連携の状態</p>
      <ol className="space-y-2.5">
        {steps.map((s) => {
          const Icon = ICONS[s.level];
          return (
            <li key={s.title} className="flex gap-2.5 text-sm">
              <Icon className={`mt-0.5 size-4 shrink-0 ${TONES[s.level]}`} />
              <div className="min-w-0">
                <div className="font-semibold text-slate-800">{s.title}</div>
                <div className="break-words text-xs text-slate-600">{s.detail}</div>
                {s.action && (
                  <div className="mt-1 break-words rounded-lg bg-white px-2 py-1 text-xs text-slate-700 ring-1 ring-slate-200">
                    対応: {s.action}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <a
        className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-cyan-700 hover:underline"
        href="/settings"
      >
        設定を開く
        <ExternalLink className="size-3" />
      </a>
    </div>
  );
}
