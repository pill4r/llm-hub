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
import { Plus, X, RefreshCw } from "lucide-react"

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

interface ModelItem {
  id: string
  name: string
}

interface ProviderFormState {
  id: string
  name: string
  protocol: string
  baseUrl: string
  authType: string
  testApiKey: string
  chatEndpoint: string
}

export default function ProvidersPanel() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<ProviderFormState>({
    id: "", name: "", protocol: "openai-compatible", baseUrl: "", authType: "bearer",
    testApiKey: "", chatEndpoint: "",
  })
  const [models, setModels] = useState<ModelItem[]>([])
  const [newModelInput, setNewModelInput] = useState("")
  const [editing, setEditing] = useState(false)
  const [testResult, setTestResult] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null)
  const [detailProvider, setDetailProvider] = useState<Provider | null>(null)

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
      autoFetchModels: false,
      models: models.map((m) => ({ id: m.id, name: m.name })),
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
        resetForm()
      }
    } catch (e: any) {
      setTestResult(t("test_failed", { error: e.message }))
    }
  }

  function resetForm() {
    setForm({ id: "", name: "", protocol: "openai-compatible", baseUrl: "", authType: "bearer", testApiKey: "", chatEndpoint: "" })
    setModels([])
    setNewModelInput("")
    setEditing(false)
  }

  async function handleTest() {
    setTestResult("")
    try {
      const body: any = {
        apiKey: form.testApiKey,
        config: {
          id: form.id || "test",
          name: form.name || "test",
          protocol: form.protocol,
          baseUrl: form.baseUrl,
          authType: form.authType,
          chatEndpoint: form.chatEndpoint || undefined,
          models: models,
          autoFetchModels: false,
        }
      }
      const resp = await apiFetch("/admin/providers/test", {
        method: "POST",
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      if (data.result?.ok || data.connected) {
        setTestResult(t("test_connected", { ms: data.result?.latencyMs || data.latency || 0 }))
      } else {
        setTestResult(t("test_failed", { error: data.result?.error || data.error || "unknown" }))
      }
    } catch (e: any) {
      setTestResult(t("test_failed", { error: e.message }))
    }
  }

  async function handleDiscoverModels() {
    setTestResult("")
    if (!form.baseUrl || !form.testApiKey) {
      setTestResult(t("test_failed", { error: "Base URL and API Key required" }))
      return
    }
    try {
      const resp = await apiFetch("/admin/providers/discover", {
        method: "POST",
        body: JSON.stringify({
          baseUrl: form.baseUrl,
          protocol: form.protocol,
          authType: form.authType,
          apiKey: form.testApiKey,
        }),
      })
      const data = await resp.json()
      if (data.error) {
        setTestResult(t("test_failed", { error: data.error.message || data.error }))
        return
      }
      if (data.models && data.models.length > 0) {
        setModels(data.models)
        setTestResult(t("models_found", { count: data.models.length }))
      } else {
        setTestResult(t("test_failed", { error: "no models" }))
      }
    } catch (e: any) {
      setTestResult(t("test_failed", { error: e.message }))
    }
  }

  async function handleFetchModelsForSaved(p: Provider) {
    setTestResult("")
    try {
      const resp = await apiFetch(`/admin/providers/${p.id}/fetch-models`, {
        method: "POST",
        body: JSON.stringify({ apiKey: form.testApiKey || "" }),
      })
      const data = await resp.json()
      if (data.error) {
        alert(data.error.message || data.error)
        return
      }
      setTestResult(t("models_found", { count: data.models.length }))
      await fetchProviders()
    } catch (e: any) {
      alert(e.message)
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
    })
    setModels([])
    setNewModelInput("")
    setEditing(true)
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  function addManualModel() {
    const id = newModelInput.trim()
    if (!id) return
    if (models.some((m) => m.id === id)) return
    setModels([...models, { id, name: id }])
    setNewModelInput("")
  }

  function removeModel(idx: number) {
    setModels(models.filter((_, i) => i !== idx))
  }

  async function loadProviderDetail(p: Provider) {
    if (p.source === "builtin") {
      setDetailProvider(p)
      return
    }
    try {
      const resp = await apiFetch(`/admin/providers/${p.id}`)
      if (!resp.ok) throw new Error("failed")
      const data = await resp.json()
      setDetailProvider({ ...p, ...mapProvider(data.config || data) })
    } catch {
      setDetailProvider(p)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{editing ? t("edit_provider_title") || "Edit Provider" : t("add_provider_title")}</CardTitle>
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
                <option value="anthropic-compatible">{t("protocol_anthropic")}</option>
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
            <div className="space-y-2 md:col-span-2">
              <Label>{t("chat_endpoint")}</Label>
              <Input placeholder="/chat/completions or /messages (auto-detected if empty)" value={form.chatEndpoint} onChange={(e) => setForm({ ...form, chatEndpoint: e.target.value })} />
            </div>
            <div className="space-y-2 md:col-span-2">
              <Label>{t("test_api_key")}</Label>
              <Input type="password" placeholder="sk-..." value={form.testApiKey} onChange={(e) => setForm({ ...form, testApiKey: e.target.value })} />
            </div>
          </div>

          {/* Models Section */}
          <div className="mt-6 rounded-lg border border-border bg-card/50 p-4">
            <div className="mb-3 flex items-center justify-between">
              <Label className="text-base font-semibold">{t("models_list") || "Models"} ({models.length})</Label>
              <Button variant="outline" size="sm" onClick={handleDiscoverModels} disabled={!form.baseUrl || !form.testApiKey}>
                <RefreshCw className="mr-1 h-3.5 w-3.5" /> {t("fetch_models")}
              </Button>
            </div>

            {models.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("no_models") || "No models configured. Click Fetch Models to auto-discover or add manually."}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {models.map((m, idx) => (
                  <Badge key={m.id} variant="secondary" className="flex items-center gap-1 px-2 py-1">
                    {m.name}
                    <button onClick={() => removeModel(idx)} className="ml-1 rounded-full hover:bg-destructive/20">
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}

            <div className="mt-3 flex gap-2">
              <Input
                placeholder="model-id"
                value={newModelInput}
                onChange={(e) => setNewModelInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addManualModel()}
                className="flex-1"
              />
              <Button variant="outline" size="sm" onClick={addManualModel}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Button onClick={handleSave}>{t("save_btn")}</Button>
            <Button variant="outline" onClick={handleTest} disabled={!form.baseUrl || !form.testApiKey}>
              {t("test_btn")}
            </Button>
            {editing && (
              <Button variant="ghost" onClick={resetForm}>
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
                  <div className="space-y-1 cursor-pointer" onClick={() => loadProviderDetail(p)}>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{p.name}</span>
                      <Badge variant={p.source === "builtin" ? "default" : "secondary"}>{t(p.source)}</Badge>
                      <Badge variant={p.status === "active" ? "outline" : "destructive"}>{t(p.status)}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      ID: {p.id} · Protocol: {p.protocol} · Base URL: {p.baseUrl || "N/A"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {p.models || 0} {t("models_count")}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.source === "dynamic" && (
                      <Button variant="outline" size="sm" onClick={() => handleFetchModelsForSaved(p)}>
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => startEdit(p)} disabled={p.source === "builtin"}>
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

      {/* Detail Dialog */}
      <Dialog open={!!detailProvider} onOpenChange={(v) => !v && setDetailProvider(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{detailProvider?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <div>ID: {detailProvider?.id}</div>
            <div>Protocol: {detailProvider?.protocol}</div>
            <div>Base URL: {detailProvider?.baseUrl || "N/A"}</div>
            <div>Models: {detailProvider?.models || 0}</div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
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
