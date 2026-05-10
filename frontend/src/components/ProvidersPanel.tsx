import { useState, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select } from "@/components/ui/select"
import { t } from "@/lib/i18n"
import { apiFetch } from "@/lib/api"

interface Provider {
  id: string
  name: string
  source: string
  status: string
  protocol: string
  baseUrl?: string
  models?: number
  capabilities?: string[]
}

function mapProvider(p: any): Provider {
  return {
    id: p.providerId || p.id,
    name: p.displayName || p.name,
    source: p.source || "builtin",
    status: "active",
    protocol: p.protocol || "openai-compatible",
    baseUrl: p.baseUrl,
    models: typeof p.models === "number" ? p.models : (p.models?.length || 0),
    capabilities: p.capabilities,
  }
}

interface ProviderFormState {
  id: string
  name: string
  protocol: string
  baseUrl: string
  authType: string
  testApiKey: string
  chatEndpoint: string
  autoFetch: string
  models: string
}

export default function ProvidersPanel() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<ProviderFormState>({
    id: "", name: "", protocol: "openai-compatible", baseUrl: "", authType: "bearer",
    testApiKey: "", chatEndpoint: "", autoFetch: "true", models: ""
  })
  const [editing, setEditing] = useState(false)
  const [testResult, setTestResult] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null)

  const fetchProviders = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await apiFetch("/admin/providers")
      if (!resp.ok) throw new Error("failed")
      const data = await resp.json()
      setProviders((data.providers || []).map(mapProvider))
    } catch {
      setProviders([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchProviders() }, [fetchProviders])

  async function handleSave() {
    setTestResult("")
    const body: any = {
      id: form.id,
      name: form.name || form.id,
      protocol: form.protocol,
      baseUrl: form.baseUrl,
      authType: form.authType,
      chatEndpoint: form.chatEndpoint || undefined,
      autoFetchModels: form.autoFetch === "true",
    }
    if (form.autoFetch !== "true") {
      body.models = form.models.split(",").map((s) => s.trim()).filter(Boolean)
    }
    try {
      const resp = await apiFetch("/admin/providers", {
        method: "POST",
        body: JSON.stringify(body),
      })
      if (!resp.ok) throw new Error(await resp.text())
      await fetchProviders()
      setTestResult(t("save_success_provider", { action: editing ? t("updated") : t("created"), id: form.id }))
      if (!editing) {
        setForm({ ...form, id: "", name: "", baseUrl: "", chatEndpoint: "", models: "" })
      }
    } catch (e: any) {
      setTestResult(t("test_failed", { error: e.message }))
    }
  }

  async function handleTest() {
    setTestResult("")
    try {
      const resp = await apiFetch(`/admin/providers/${form.id}/test`, {
        method: "POST",
        body: JSON.stringify({ apiKey: form.testApiKey }),
      })
      const data = await resp.json()
      if (data.connected) {
        setTestResult(t("test_connected", { ms: data.latency || 0 }))
      } else {
        setTestResult(t("test_failed", { error: data.error || "unknown" }))
      }
    } catch (e: any) {
      setTestResult(t("test_failed", { error: e.message }))
    }
  }

  async function handleFetchModels() {
    setTestResult("")
    try {
      const resp = await apiFetch(`/admin/providers/${form.id}/fetch-models`, {
        method: "POST",
        body: JSON.stringify({ apiKey: form.testApiKey }),
      })
      const data = await resp.json()
      if (data.models && data.models.length > 0) {
        setForm((prev) => ({ ...prev, autoFetch: "false", models: data.models.join(", ") }))
        setTestResult(t("models_found", { count: data.models.length }))
      } else {
        setTestResult(t("test_failed", { error: data.error || "no models" }))
      }
    } catch (e: any) {
      setTestResult(t("test_failed", { error: e.message }))
    }
  }

  async function handleDelete(p: Provider) {
    if (!p) return
    try {
      const resp = await apiFetch(`/admin/providers/${p.id}`, { method: "DELETE" })
      if (!resp.ok) throw new Error(await resp.text())
      await fetchProviders()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setDeleteTarget(null)
    }
  }

  function startEdit(p: Provider) {
    setForm({
      id: p.id,
      name: p.name,
      protocol: p.protocol || "openai-compatible",
      baseUrl: p.baseUrl || "",
      authType: "bearer",
      testApiKey: "",
      chatEndpoint: "",
      autoFetch: "true",
      models: typeof p.models === "string" ? p.models : "",
    })
    setEditing(true)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("add_provider_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t("provider_id")}</Label>
              <Input placeholder={t("provider_id_placeholder")} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} disabled={editing} />
            </div>
            <div className="space-y-2">
              <Label>{t("display_name")}</Label>
              <Input placeholder={t("display_name_placeholder")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t("protocol")}</Label>
              <Select value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })}>
                <option value="openai-compatible">{t("protocol_openai")}</option>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("auth_type")}</Label>
              <Select value={form.authType} onChange={(e) => setForm({ ...form, authType: e.target.value })}>
                <option value="bearer">{t("auth_bearer")}</option>
                <option value="api-key">{t("auth_api_key")}</option>
                <option value="x-api-key">{t("auth_x_api_key")}</option>
              </Select>
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>{t("base_url")}</Label>
              <Input placeholder={t("base_url_placeholder")} value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t("chat_endpoint")}</Label>
              <Input value={form.chatEndpoint} onChange={(e) => setForm({ ...form, chatEndpoint: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>{t("auto_fetch_models")}</Label>
              <Select value={form.autoFetch} onChange={(e) => setForm({ ...form, autoFetch: e.target.value })}>
                <option value="true">{t("yes")}</option>
                <option value="false">{t("no")}</option>
              </Select>
            </div>
            {form.autoFetch === "false" && (
              <div className="space-y-2 md:col-span-2">
                <Label>{t("models")}</Label>
                <Input placeholder={t("models_placeholder")} value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} />
              </div>
            )}
            <div className="space-y-2">
              <Label>{t("test_api_key")}</Label>
              <Input type="password" value={form.testApiKey} onChange={(e) => setForm({ ...form, testApiKey: e.target.value })} />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={handleSave}>{t("save_btn")}</Button>
            <Button variant="outline" onClick={handleTest}>{t("test_btn")}</Button>
            <Button variant="outline" onClick={handleFetchModels}>{t("fetch_models")}</Button>
            {editing && (
              <Button variant="ghost" onClick={() => { setEditing(false); setForm({ id: "", name: "", protocol: "openai-compatible", baseUrl: "", authType: "bearer", testApiKey: "", chatEndpoint: "", autoFetch: "true", models: "" }) }}>
                Cancel
              </Button>
            )}
          </div>

          {testResult && (
            <div className="mt-4 rounded-md bg-secondary/30 p-3 text-sm">
              {testResult}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("providers_list_title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-muted-foreground">{t("loading")}</p>
          ) : providers.length === 0 ? (
            <p className="text-muted-foreground">{t("no_providers")}</p>
          ) : (
            <div className="space-y-3">
              {providers.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-lg border border-border p-4 hover:bg-accent/30 transition-colors">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{p.name}</span>
                      <Badge variant={p.source === "builtin" ? "default" : "secondary"}>{t(p.source)}</Badge>
                      <Badge variant={p.status === "active" ? "outline" : "destructive"}>{t(p.status)}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      ID: {p.id} · Protocol: {p.protocol} · Base URL: {p.baseUrl}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {p.models || 0} {t("models_count")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => startEdit(p)}>
                      Edit
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(p)} disabled={p.source === "builtin"}>
                      Delete
                    </Button>
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
            {t("delete_confirm_provider", { name: deleteTarget?.name || "" })}
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
