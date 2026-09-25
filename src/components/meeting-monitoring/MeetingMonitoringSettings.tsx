/**
 * Settings → 会議モニタリング (§30) and the privacy panel (§31).
 *
 * A separate card appended to the existing settings screen. The original 検知ルール
 * card is untouched: these are the organizer-layer knobs, versioned separately,
 * and saving one does not bump the other's rule version.
 */
import { useEffect, useState } from "react";
import { Save, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AppCard, CardHead, LoadingRows } from "@/components/shell/primitives";
import { api, ApiClientError, type MeetingMonitoringConfig } from "@/lib/api";
import { useCan } from "@/lib/auth-context";

type NumericKey = {
  [K in keyof MeetingMonitoringConfig]: MeetingMonitoringConfig[K] extends number ? K : never;
}[keyof MeetingMonitoringConfig];

type BooleanKey = {
  [K in keyof MeetingMonitoringConfig]: MeetingMonitoringConfig[K] extends boolean ? K : never;
}[keyof MeetingMonitoringConfig];

const FEATURES: { key: BooleanKey; label: string; hint: string }[] = [
  { key: "faceMonitoringEnabled", label: "顔モニタリング", hint: "顔検出・追跡を有効にします" },
  { key: "identityVerificationEnabled", label: "本人確認", hint: "登録済み顔との1:N照合を行います" },
  { key: "screenFacingEnabled", label: "画面正対の解析", hint: "視線・顔の向きから画面正対度を推定します" },
  { key: "headPoseEnabled", label: "頭部姿勢の解析", hint: "ヨー・ピッチ・ロールを算出します" },
  { key: "multiFaceEnabled", label: "複数人検出", hint: "1つの映像内に複数の顔がある場合に検知します" },
  { key: "drowsinessEnabled", label: "閉眼・居眠り疑いの検知", hint: "閉眼の継続を検知します。あくまで「疑い」であり、自動判定はしません" },
  { key: "participationAnalyticsEnabled", label: "参加状況の集計", hint: "発話時間・発話回数を集計します" },
  { key: "transcriptEnabled", label: "文字起こし解析", hint: "Zoomの文字起こしが利用可能な場合のみ（任意）" },
  {
    key: "autoSessionEnabled",
    label: "Zoom会議の自動取り込み",
    hint: "連携中のZoomアカウントで会議が開始されたとき、対応する研修を自動作成して参加者を取り込みます",
  },
  {
    key: "botAutoJoinEnabled",
    label: "監視ボットの自動参加",
    hint: "Ayonix監視ボットが開催中の会議に自動で参加し、各参加者の映像を解析します",
  },
];

export function MeetingMonitoringSettingsCard() {
  const can = useCan();
  const [config, setConfig] = useState<MeetingMonitoringConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    api
      .getMeetingSettings()
      .then((r) => setConfig(r.settings))
      .catch(() => setConfig(null))
      .finally(() => setLoading(false));
  }, []);

  async function save() {
    if (!config) return;
    setSaving(true);
    try {
      const { version: _v, ...patch } = config;
      const r = await api.saveMeetingSettings(patch);
      setConfig(r.settings);
      setNotice(`会議モニタリング設定を保存しました（版 ${r.settings.version}）`);
    } catch (e) {
      setNotice(e instanceof ApiClientError ? e.message : "保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <AppCard>
        <LoadingRows rows={6} />
      </AppCard>
    );
  }
  if (!config) return null;

  const editable = can("monitoring:write");

  const num = (key: NumericKey, label: string, hint: string, min: number, max: number, step = 1) => (
    <div className="space-y-1.5">
      <label className="field-label" htmlFor={`mm-${key}`}>
        {label}
      </label>
      <Input
        id={`mm-${key}`}
        type="number"
        min={min}
        max={max}
        step={step}
        value={String(config[key])}
        disabled={!editable}
        onChange={(e) => setConfig({ ...config, [key]: Number(e.target.value) })}
      />
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  );

  const toggle = (key: BooleanKey, label: string, hint: string) => (
    <div key={key} className="space-y-1.5">
      <label className="field-label" htmlFor={`mm-${key}`}>
        {label}
      </label>
      <div className="flex items-center gap-3 pt-1">
        <Switch
          id={`mm-${key}`}
          checked={config[key]}
          disabled={!editable}
          onCheckedChange={(v) => setConfig({ ...config, [key]: v })}
        />
        <span className="text-sm text-slate-600">{config[key] ? "有効" : "無効"}</span>
      </div>
      <p className="text-xs text-slate-500">{hint}</p>
    </div>
  );

  return (
    <>
      {notice && (
        <div role="status" className="rounded-xl border border-cyan-200 bg-cyan-50 px-4 py-2.5 text-sm text-cyan-800">
          {notice}
          <button type="button" className="ml-3 font-bold underline" onClick={() => setNotice(null)}>
            閉じる
          </button>
        </div>
      )}

      <AppCard>
        <CardHead
          title="会議モニタリング"
          description={`Zoom会議の主催者向け解析設定（版 ${config.version}）。研修受講画面の検知ルールとは独立しています。`}
          action={
            editable ? (
              <Button size="sm" className="gap-1.5" onClick={() => void save()} disabled={saving}>
                <Save className="size-3.5" />
                {saving ? "保存中…" : "保存"}
              </Button>
            ) : undefined
          }
        />

        <div className="space-y-6 border-t border-slate-100 p-5">
          <section>
            <h4 className="mb-3 flex items-center gap-2 text-sm font-bold text-slate-800">
              <SlidersHorizontal className="size-4 text-slate-400" />
              解析機能
            </h4>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {FEATURES.map((f) => toggle(f.key, f.label, f.hint))}
            </div>
          </section>

          <section>
            <h4 className="mb-3 text-sm font-bold text-slate-800">解析頻度</h4>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {num("normalFps", "通常時のFPS", "全フレームは処理しません。既定2 FPS", 0.2, 15, 0.1)}
              {num("elevatedFps", "重点監視時のFPS", "状態変化中・要確認時のサンプリング。既定5 FPS", 0.5, 30, 0.1)}
              {num("normalIntervalSec", "通常の解析間隔（秒）", "安定している参加者の再解析間隔", 1, 300)}
              {num("warmIntervalSec", "注視の解析間隔（秒）", "状態が変化した直後の参加者", 1, 120)}
              {num("hotIntervalSec", "重点監視の解析間隔（秒）", "本人未確認・異常検知中の参加者", 1, 60)}
            </div>
          </section>

          <section>
            <h4 className="mb-3 text-sm font-bold text-slate-800">状態の確定と検知しきい値</h4>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {num("transientSec", "一時的な動きとして無視する秒数", "これ未満の変化は状態変更とみなしません", 1, 60)}
              {num("temporarySec", "暫定状態とする秒数", "この間は状態表示のみでイベント化しません", 1, 300)}
              {num("prolongedSec", "長時間継続とみなす秒数", "これを超えるとイベントを重大度ALERTへ引き上げます", 5, 3600)}
              {num("faceMissingSec", "顔が映っていない判定（秒）", "この秒数継続でイベントを作成します", 3, 600)}
              {num("screenAwaySec", "画面から視線が外れた判定（秒）", "顔の向き・視線が外れた状態の継続秒数", 3, 600)}
              {num("cameraOffSec", "カメラオフ判定（秒）", "カメラがオフのまま継続した秒数", 5, 3600)}
              {num("multiFaceSec", "複数人検出の判定（秒）", "通行人などの一瞬の写り込みを除外します", 1, 300)}
              {num("longAbsenceSec", "長時間不在の判定（秒）", "この秒数を超えると重大イベントとして扱います", 30, 7200)}
              {num("eyesClosedSec", "閉眼の判定（秒）", "通常のまばたきを除外するため、この秒数の継続で「居眠りの疑い」とします", 3, 300)}
              {num("yawThresholdDeg", "左右方向のしきい値（度）", "これを超えると左右を向いていると判定します", 5, 80)}
              {num("pitchUpThresholdDeg", "上方向のしきい値（度）", "これを超えると上を向いていると判定します", 5, 80)}
              {num("pitchDownThresholdDeg", "下方向のしきい値（度）", "手元・スマートフォンを見る動作の判定に影響します", 5, 80)}
              {num("screenFacingThreshold", "画面正対のしきい値", "0〜1。これ以上で「画面正対」と表示します", 0.1, 0.99, 0.01)}
            </div>
          </section>

          <section>
            <h4 className="mb-3 text-sm font-bold text-slate-800">本人確認</h4>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {num("identityConfidenceThreshold", "一致しきい値", "これ未満は「確認できず」として扱い、別人とは判定しません", 0.5, 0.999, 0.01)}
              {num("identityCacheSec", "確認結果の有効期間（秒）", "この期間は再照合を省略します。再入室・複数人検出時は即時無効化されます", 30, 7200)}
              {num("lowConfidenceThreshold", "低信頼度のしきい値", "検出信頼度がこれ未満の場合は「信頼度が低い」と表示します", 0.05, 0.9, 0.01)}
            </div>
          </section>

          <section>
            <h4 className="mb-3 text-sm font-bold text-slate-800">証跡と保存期間</h4>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {toggle(
                "snapshotsEnabled",
                "証跡スナップショット",
                "既定は無効です。有効にすると検知時の静止画を暗号化して保存します",
              )}
              {num("snapshotRetentionDays", "スナップショット保存期間（日）", "期限後に自動削除されます", 1, 365)}
              {num("observationRetentionDays", "解析データ保存期間（日）", "サンプル単位の観測データ。レポートは保存後も残ります", 1, 365)}
              {num("eventRetentionDays", "イベント保存期間（日）", "解消済みイベントのみ自動削除の対象です", 1, 3650)}
              {num("transcriptRetentionDays", "文字起こし保存期間（日）", "文字起こし解析が有効な場合のみ", 1, 3650)}
              {toggle("alertNotificationsEnabled", "アラート通知", "既存のアラート受信箱へ重大イベントを連携します")}
            </div>
          </section>
        </div>
      </AppCard>

      <AppCard>
        <CardHead title="会議モニタリングのプライバシー" description="参加者への説明に使用できる現在の設定内容" />
        <div className="space-y-2 border-t border-slate-100 p-5 text-sm text-slate-600">
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            映像は解析のみに使用し、<strong>録画は行いません</strong>。解析後のフレームは破棄されます。
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            スナップショットの保存は現在
            <strong>{config.snapshotsEnabled ? `有効（${config.snapshotRetentionDays}日保存）` : "無効"}</strong>
            です。
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            本人確認は<strong>{config.identityVerificationEnabled ? "有効" : "無効"}</strong>、文字起こし解析は
            <strong>{config.transcriptEnabled ? "有効" : "無効"}</strong>です。
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            解析データは{config.observationRetentionDays}日、イベントは{config.eventRetentionDays}
            日で自動削除されます。集計済みレポートのみ保持されます。
          </p>
          <p className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            記録するのは観測可能な事象（顔の有無・向き・カメラ状態など）のみで、
            <strong>理解度・集中度・心理状態は判定しません</strong>。
          </p>
        </div>
      </AppCard>
    </>
  );
}
