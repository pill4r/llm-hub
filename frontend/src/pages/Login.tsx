import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { t } from "@/lib/i18n"
import { apiFetch, setAdminToken } from "@/lib/api"

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)

  async function handleLogin() {
    setError("")
    setLoading(true)
    try {
      const resp = await fetch("/admin/providers", {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (resp.status === 401) {
        setError(t("login_invalid"))
        return
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      setAdminToken(token)
      onLogin()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-[80vh] items-center justify-center">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-xl">
        <h1 className="mb-2 text-center text-2xl font-bold text-primary">{t("login_title")}</h1>
        <p className="mb-6 text-center text-sm text-muted-foreground">{t("login_subtitle")}</p>
        <div className="space-y-4">
          <Input
            type="password"
            placeholder={t("admin_token_placeholder")}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            className="text-center font-mono"
          />
          <Button className="w-full" onClick={handleLogin} disabled={loading}>
            {loading ? "..." : t("login_btn")}
          </Button>
          {error && (
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
