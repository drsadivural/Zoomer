import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Copy, ExternalLink, Link2, ShieldCheck, SlidersHorizontal, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, ApiClientError, type MonitoringSettings, type ZoomStatus } from "@/lib/api";
import { AppCard, CardHead, ErrorNotice, LoadingRows } from "@/components/shell/primitives";
import { formatDateTime } from "@/lib/format";
import { useCan } from "@/lib/auth-context";

export function SettingsScreen() {
  const can = useCan();
  const [params] = useSearchParams();
  const [settings, setSettings] = useState<MonitoringSettings | null>(null);
  const [zoom, setZoom] = useState<ZoomStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  function load() {
    setLoading(true);
    Promise.all([api.getSettings(), api.zoomStatus().catch(() => null)])
      .then(([s, z]) => {
        setSettings(s.settings);
        setZoom(z);
        setError(null);
      })
      .catch((e) => setError(e instanceof ApiClientError ? e.message : "設定を取得できません"))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    const zoomParam = params.get("zoom");
    if (zoomParam === "connected") setNotice("Zoom連携を接続しました。");
    if (zoomParam === "error") setNotice(`Zoom連携に失敗しました: ${params.get("reason") ?? "不明なエラー"}`);
  }, [params]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setNotice(null);
    try {
      const { version: _version, ...rest } = settings;
      const r = await api.saveSettings(rest);
      setSettings(r.settings);
      setNotice(`検知ルールを保存しました（ルール版 ${r.settings.version}）。既に進行中の研修には適用されません。`);
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  async function connectZoom() {
    try {
      const { url } = await api.zoomAuthorize();
      window.location.href = url;
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "Zoom連携を開始できません");
    }
  }

  async function disconnectZoom() {
    await api.zoomDisconnect().catch(() => undefined);
    load();
  }

  if (error) return <ErrorNotice message={error} onRetry={load} />;
  if (loading || !settings) return <AppCard><LoadingRows rows={8} /></AppCard>;

  const num = (key: keyof MonitoringSettings, label: string, hint: string, min: number, max: number, step = 1) => (
    <div className="space-y-1.5">
      <label className="field-label" htmlFor={`s-${key}`}>{label}</label>
      <Input
        id={`s-${key}`}
        type="number"
        min={min}
        max={max}
        step={step}
        value={String(settings[key])}
        disabled={!can("settings:write")}
        onChange={(e) => setSettings({ ...settings, [key]: Number(e.target.value) })}
      />
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  );

  return (
    <>
      {notice && (
        <div role="status" className="rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-sm text-cyan-800">
          {notice}
          <button type="button" className="ml-3 font-bold underline" onClick={() => setNotice(null)}>閉じる</button>
        </div>
      )}

      <AppCard>
        <CardHead
          title="Zoom連携"
          description="研修予定・開催状態・参加者情報を同期します。参加者の映像は取得しません。"
          action={
            zoom?.connected && can("integration:manage") ? (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void disconnectZoom()}>
                <Unlink className="size-3.5" />
                切断
              </Button>
            ) : undefined
          }
        />
        <div className="space-y-4 border-t border-slate-100 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-semibold ${
                zoom?.connected
                  ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border-slate-200 bg-slate-50 text-slate-600"
              }`}
            >
              {zoom?.connected ? <Check className="size-4" /> : <Link2 className="size-4" />}
              {zoom?.connected ? "接続済み" : "未接続"}
            </span>
            {zoom?.integration?.connectedAt && (
              <span className="text-xs text-slate-500">
                接続日時 {formatDateTime(zoom.integration.connectedAt)}
              </span>
            )}
            {!zoom?.connected && can("integration:manage") && (
              <Button size="sm" className="gap-1.5" onClick={() => void connectZoom()} disabled={!zoom?.configured}>
                <ExternalLink className="size-3.5" />
                Zoomアカウントを接続
              </Button>
            )}
          </div>

          {!zoom?.configured && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
              ZoomアプリのClient ID / Client Secret がサーバーに設定されていません。
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-bold text-slate-800">Zoom Marketplace に登録する値</p>
            <p className="mt-1 text-xs text-slate-500">
              Zoomアプリの設定画面で、以下のURLを登録してください。値が完全に一致しない場合、
              認可時に <code>4700 Invalid redirect</code> になります。
            </p>
            <div className="mt-3 space-y-2">
              <CopyRow label="OAuth Redirect URL" value={zoom?.redirectUri ?? ""} />
              <CopyRow label="Event notification endpoint URL" value={zoom?.webhookUrl ?? ""} />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              購読するイベント: <code>meeting.started</code>, <code>meeting.ended</code>,{" "}
              <code>meeting.participant_joined</code>, <code>meeting.participant_left</code>
              {zoom && !zoom.webhookConfigured && (
                <span className="ml-1 font-semibold text-amber-600">
                  （Secret Token が未設定のため、現在Webhookは受信できません）
                </span>
              )}
            </p>
          </div>
        </div>
      </AppCard>

      <AppCard>
        <CardHead
          title="検知ルール"
          description={`現在のルール版 ${settings.version}。保存すると新しい版として記録され、進行中の研修は従来の版で判定を続けます。`}
          action={
            can("settings:write") ? (
              <Button size="sm" className="gap-1.5" onClick={() => void save()} disabled={saving}>
                <SlidersHorizontal className="size-3.5" />
                {saving ? "保存中…" : "保存"}
              </Button>
            ) : undefined
          }
        />
        <div className="grid gap-4 border-t border-slate-100 p-5 sm:grid-cols-2 xl:grid-cols-3">
          {num("reauthIntervalSec", "継続認証の間隔（秒）", "この間隔で顔を再照合します", 15, 900)}
          {num("matchThreshold", "顔一致しきい値", "コサイン類似度。実データでのFAR/FRR測定に基づき調整してください", 0.5, 0.999, 0.01)}
          {num("absenceSec", "離席判定秒数", "顔が検出できない状態がこの秒数続いたら離席とします", 10, 600)}
          {num("eyesClosedSec", "閉眼秒数", "この秒数を超えたら居眠り疑いとして管理者確認へ回します", 3, 120)}
          {num("multiFaceFrames", "複数人の連続フレーム数", "誤検知を避けるため、単発フレームでは判定しません", 3, 300)}
          {num("evidenceIntervalSec", "定期証跡の間隔（秒）", "0に近い値は保存容量が増加します", 30, 3600)}
          {num("evidenceRetentionDays", "証跡保存期間（日）", "期限を過ぎた画像は自動削除され、削除ログが残ります", 1, 365)}
          {num("precheckMaxAttempts", "本人確認の試行上限", "上限を超えた場合は管理者確認に回します（自動不合格にはしません）", 1, 10)}
          {num("imageQuality", "証跡画質", "0.3〜1.0。高いほど鮮明で容量が増えます", 0.3, 1, 0.01)}
          <div className="space-y-1.5">
            <label className="field-label" htmlFor="s-liveness">生体検知（ライブネス）</label>
            <div className="flex items-center gap-3 pt-1">
              <Switch
                id="s-liveness"
                checked={settings.livenessRequired}
                disabled={!can("settings:write")}
                onCheckedChange={(v) => setSettings({ ...settings, livenessRequired: v })}
              />
              <span className="text-sm text-slate-600">
                {settings.livenessRequired ? "必須（写真・画面再生を拒否）" : "任意"}
              </span>
            </div>
            <p className="text-xs text-slate-500">
              瞬きと自然な動きを要求します。本番運用前に写真・スマホ再生・マスクでの評価が必要です。
            </p>
          </div>
        </div>
      </AppCard>

      <AppCard>
        <CardHead title="プライバシーと保存" description="運用開始前に顧客と確定する項目" />
        <div className="space-y-2 border-t border-slate-100 p-5 text-sm text-slate-600">
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            顔特徴量はAES-256-GCMで暗号化して保存し、原画像は保存しません。監査ログに特徴量・画像URL・トークンは記録されません。
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            証跡画像は暗号化保存され、閲覧は60秒で失効する署名URL経由のみです。閲覧・出力・削除はすべて監査ログに記録されます。
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            居眠りは「疑い」として扱い、自動判定のみで受講不可とはしません。必ず管理者の確認を経ます。
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            データはAPACリージョン（D1 / R2）に保存されます。国内保存要件がある場合は導入前に確認してください。
          </p>
        </div>
      </AppCard>
    </>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="text-xs font-semibold text-slate-600">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="flex-1 truncate rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-700">
          {value || "—"}
        </code>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={async () => {
            await navigator.clipboard.writeText(value).catch(() => undefined);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "コピー済" : "コピー"}
        </Button>
      </div>
    </div>
  );
}
