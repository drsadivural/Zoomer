import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/lib/auth-context";
import { Logo } from "@/components/shell/primitives";

export function LoginScreen() {
  const { login, error } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await login(email, password);
    } catch {
      // Message is surfaced from context; keep the form filled for a retry.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-[#f4f7fb] p-4">
      <div className="w-full max-w-md">
        <div className="hero-strip mb-5 !min-h-[130px] !flex-col !items-start gap-3">
          <Logo />
          <p className="text-sm text-cyan-100">
            オンライン研修の本人確認・受講監視システム
          </p>
        </div>

        <form onSubmit={submit} className="app-card space-y-4 p-6">
          <div>
            <h1 className="text-lg font-extrabold text-slate-950">管理者ログイン</h1>
            <p className="mt-1 text-sm text-slate-500">
              組織から発行されたアカウントでログインしてください。
            </p>
          </div>

          {error && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2.5 text-sm text-rose-700">
              {error}
            </div>
          )}

          <div className="space-y-1.5">
            <label className="field-label" htmlFor="email">メールアドレス</label>
            <Input
              id="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.co.jp"
            />
          </div>

          <div className="space-y-1.5">
            <label className="field-label" htmlFor="password">パスワード</label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <Button type="submit" className="w-full gap-2" disabled={busy}>
            <ShieldCheck className="size-4" />
            {busy ? "確認中…" : "ログイン"}
          </Button>

          <p className="text-xs leading-relaxed text-slate-500">
            受講者の方は、研修案内メールに記載された受講リンクからアクセスしてください。
          </p>
        </form>
      </div>
    </div>
  );
}
