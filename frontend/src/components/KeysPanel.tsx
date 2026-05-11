import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { t } from "@/lib/i18n"
import { apiFetch } from "@/lib/api"
import { Check, Copy } from "lucide-react"

interface HubKey {
  id: string
  name: string
  token: string
  status: string
  permissions?: string[]
  monthlyBudget?: number
  rpmLimit?: number
  tpmLimit?: number
  allowedProviders?: string[]
  allowedModels?: string[]
  providerKeys?: Record<string, string>
}

interface KeyRecord {
  name: string
  status: string
  monthlyBudget: number
  rpmLimit: number
  tpmLimit: number
  allowedProviders: string[]
  allowedModels: string[]
  providerKeys: Record<string, string>
  used: number
}

export default function KeysPanel() {
  const [keys, setKeys] = useState<Record<string, KeyRecord>>({})
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({
    name: "", monthlyBudget: "0", rpm: "60", tpm: "100000",
    allowedProviders: "", allowedModels: ""
  })
  const [newToken, setNewToken] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const fetchKeys = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await apiFetch("/admin/keys")
      if (!resp.ok) throw new Error("failed")
      const data = await resp.json()
      setKeys(data.keys || {})
    } catch {
      setKeys({})
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchKeys() }, [fetchKeys])

  async function handleCreate() {
    setNewToken("")
    const body = {
      name: form.name,
      monthlyBudget: parseFloat(form.monthlyBudget) || 0,
      rpmLimit: parseInt(form.rpm) || 60,
      tpmLimit: parseInt(form.tpm) || 100000,
      allowedProviders: form.allowedProviders.split(",").map(s => s.trim()).filter(Boolean),
      allowedModels: form.allowedModels.split(",").map(s => s.trim()).filter(Boolean),
    }
    try {
      const resp = await apiFetch("/admin/keys", {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!resp.ok) throw new Error(await resp.text())
      const data = await resp.json()
      setNewToken(data.token || "")
      setForm({ name: "", monthlyBudget: "0", rpm: "60", tpm: "100000", allowedProviders: "", allowedModels: "" })
      await fetchKeys()
    } catch (e: any) {
      alert(e.message)
    }
  }

  async function handleDelete(id: string) {
    try {
      const resp = await apiFetch(`/admin/keys/${id}`, { method: "DELETE" })
      if (!resp.ok) throw new Error(await resp.text())
      await fetchKeys()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setDeleteTarget(null)
    }
  }

  function copyToken() {
    navigator.clipboard.writeText(newToken)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("create_key_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("key_name")}</Label>
              <Input placeholder={t("key_name_placeholder")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t("monthly_budget")}</Label>
              <Input type="number" value={form.monthlyBudget} onChange={(e) => setForm({ ...form, monthlyBudget: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t("rpm")}</Label>
              <Input type="number" value={form.rpm} onChange={(e) => setForm({ ...form, rpm: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t("tpm")}</Label>
              <Input type="number" value={form.tpm} onChange={(e) => setForm({ ...form, tpm: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t("allowed_providers")}</Label>
              <Input placeholder={t("allowed_providers_hint")} value={form.allowedProviders} onChange={(e) => setForm({ ...form, allowedProviders: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t("allowed_models")}</Label>
              <Input placeholder={t("allowed_models_hint")} value={form.allowedModels} onChange={(e) => setForm({ ...form, allowedModels: e.target.value })} />
            </div>
          </div>
          <div className="mt-4">
            <Button onClick={handleCreate}>{t("create_key_btn")}</Button>
          </div>

          {newToken && (
            <div className="mt-4 rounded-md bg-primary/10 p-4">
              <p className="mb-2 text-sm font-medium">{t("key_created")}</p>
              <p className="mb-2 text-xs text-muted-foreground">{t("copy_token")}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-background p-2 text-xs font-mono break-all">{newToken}</code>
                <Button size="icon" variant="outline" onClick={copyToken}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("keys_list_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">{t("loading")}</p>
          ) : Object.keys(keys).length === 0 ? (
            <p className="text-muted-foreground">{t("no_keys")}</p>
          ) : (
            <div className="space-y-3">
              {Object.entries(keys).map(([id, k]) => (
                <div key={id} className="rounded-lg border border-border p-4 hover:bg-accent/30 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{k.name}</span>
                      <Badge variant={k.status === "active" ? "default" : "destructive"}>{t(k.status)}</Badge>
                    </div>
                    <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(id)}>Delete</Button>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground space-y-1">
                    <div>ID: {id}</div>
                    <div>{t("budget_label")}: ${k.monthlyBudget || 0} · {t("used_label")}: ${k.used || 0}</div>
                    <div>RPM: {k.rpmLimit} · TPM: {k.tpmLimit}</div>
                    {k.allowedProviders?.length > 0 && <div>Providers: {k.allowedProviders.join(", ")}</div>}
                    {k.allowedModels?.length > 0 && <div>Models: {k.allowedModels.join(", ")}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm Delete</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("delete_confirm_key", { name: keys[deleteTarget || ""]?.name || "" })}
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => handleDelete(deleteTarget!)}>Delete</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
