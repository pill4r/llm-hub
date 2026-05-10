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
import { Plus, X, RefreshCw, TestTube, Trash2 } from "lucide-react"

interface Provider {
  id: string
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
    source: p.source || "builtin",
    status: "active",
    protocol: p.protocol || "openai-compatible",
    baseUrl: p.baseUrl,
    models: typeof p.models === "number" ? p.models : (Array.isArray(p.models) ? p.models.length : 0),
    capabilities: p.capabilities,
  }
}

interface ProviderFormState {
  id: string
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
    id: "", protocol: "openai-compatible", baseUrl: "", authType: "bearer",
    testApiKey: "", chatEndpoint: "",
  })
  const [models, setModels] = useState<string[]>([])
  const [newModelInput, setNewModelInput] = useState("")
  const [editing, setEditing] = useState(false)
  const [testResult, setTestResult] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null)
  const [detailProvider, setDetailProvider] = useState<Provider | null>(null)
  const [modelTestStatus, setModelTestStatus] = useState<Record<string, "pending" | "ok" | "error">>({})
  const [modelLatency, setModelLatency] = useState<Record<string, number>>({})

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
      providerId: form.id,
      protocol: form.protocol,
      baseUrl: form.baseUrl,
      authType: form.authType,
      chatEndpoint: form.chatEndpoint || undefined,
      autoFetchModels: false,
      models,
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
    setForm({ id: "", protocol: "openai-compatible", baseUrl: "", authType: "bearer", testApiKey: "", chatEndpoint: "" })
    setModels([])
    setNewModelInput("")
    setEditing(false)
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

  async function testModel(modelId: string) {
    setModelTestStatus((prev) => ({ ...prev, [modelId]: "pending" }))
    try {
      const body: any = {
        apiKey: form.testApiKey,
        config: {
          providerId: form.id || "test",
          protocol: form.protocol,
          baseUrl: form.baseUrl,
          authType: form.authType,
          chatEndpoint: form.chatEndpoint || undefined,
          models: [modelId],
          autoFetchModels: false,
        }
      }
      const resp = await apiFetch("/admin/providers/test", {
        method: "POST",
        body: JSON.stringify(body),
      })
      const data = await resp.json()
      const latency = data.result?.latencyMs || data.latency || 0
      if (data.result?.ok || data.connected) {
        setModelTestStatus((prev) => ({ ...prev, [modelId]: "ok" }))
        setModelLatency((prev) => ({ ...prev, [modelId]: latency }))
      } else {
        setModelTestStatus((prev) => ({ ...prev, [modelId]: "error" }))
      }
    } catch {
      setModelTestStatus((prev) => ({ ...prev, [modelId]: "error" }))
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
    if (models.includes(id)) return
    setModels([...models, id])
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
            <div className="space-y-2 md:col-span-2">
              <Label>{t("provider_id")}</Label>
              <Input placeholder={t("provider_id_placeholder")} value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} disabled={editing} />
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
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-3">
                {models.map((m, idx) => {
                  const status = modelTestStatus[m]
                  const latency = modelLatency[m]
                  const borderColor = status === "ok"
                    ? "border-green-500/40"
                    : status === "error"
                    ? "border-red-500/40"
                    : "border-border"
                  const bgColor = status === "ok"
                    ? "bg-green-500/5"
                    : status === "error"
                    ? "bg-red-500/5"
                    : "bg-card"

                  return (
                    <div
                      key={m}
                      className={`flex items-center justify-between rounded-lg border ${borderColor} ${bgColor} px-3 py-2.5 transition-colors`}
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{m}</div>
                        {status === "ok" && latency > 0 && (
                          <div className="text-xs text-green-400">{latency}ms</div>
                        )}
                      </div>
                      <div className="ml-2 flex items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => testModel(m)}
                          disabled={status === "pending" || !form.testApiKey}
                          title="Test"
                        >
                          {status === "pending" ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          ) : status === "ok" ? (
                            <TestTube className="h-3.5 w-3.5 text-green-400" />
                          ) : status === "error" ? (
                            <TestTube className="h-3.5 w-3.5 text-red-400" />
                          ) : (
                            <TestTube className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => removeModel(idx)}
                          title="Remove"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
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
                      <span className="font-semibold">{p.id}</span>
                      <Badge variant={p.source === "builtin" ? "default" : "secondary"}>{t(p.source)}</Badge>
                      <Badge variant={p.status === "active" ? "outline" : "destructive"}>{t(p.status)}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Protocol: {p.protocol} · Base URL: {p.baseUrl || "N/A"}
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
            <DialogTitle>{detailProvider?.id}</DialogTitle>
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
            <DialogTitle>Delete Provider</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete <strong>{deleteTarget?.id}</strong>?
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteTarget && handleDelete(deleteTarget)}>Delete</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
