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
import { Plus, RefreshCw, TestTube, Trash2 } from "lucide-react"

interface Provider {
  id: string
  source: string
  status: string
  protocol: string
  baseUrl?: string
  models?: number
  capabilities?: string[]
}

interface SupportedFormat {
  providerId: string
  providerName: string
  protocol: string
  source: string
  capabilities?: Record<string, boolean>
}

function mapProvider(p: any): Provider {
  return {
    id: p.providerId || p.id,
    source: p.source || "configured",
    status: "active",
    protocol: p.protocol || "openai-compatible",
    baseUrl: p.baseUrl,
    models: typeof p.models === "number" ? p.models : (Array.isArray(p.models) ? p.models.length : 0),
    capabilities: p.capabilities,
  }
}

function mapSupportedFormat(r: any): SupportedFormat {
  return {
    providerId: r.providerId || r.id,
    providerName: r.providerName || r.name || r.providerId || r.id,
    protocol: r.protocol || "openai-compatible",
    source: "format",
    capabilities: r.capabilities,
  }
}

interface ProviderFormState {
  id: string
  protocol: string
  baseUrl: string
  authType: string
  testApiKey: string
  chatEndpoint: string
  transformsJson: string
}

export default function ProvidersPanel() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [supportedFormats, setSupportedFormats] = useState<SupportedFormat[]>([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState<ProviderFormState>({
    id: "", protocol: "openai-compatible", baseUrl: "", authType: "bearer",
    testApiKey: "", chatEndpoint: "", transformsJson: "",
  })
  const [models, setModels] = useState<string[]>([])
  const [newModelInput, setNewModelInput] = useState("")
  const [editing, setEditing] = useState(false)
  const [testResult, setTestResult] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<Provider | null>(null)
  const [detailProvider, setDetailProvider] = useState<Provider | null>(null)
  const [modelTestStatus, setModelTestStatus] = useState<Record<string, "pending" | "ok" | "error">>({})
  const [modelLatency, setModelLatency] = useState<Record<string, number>>({})
  const [transformsOpen, setTransformsOpen] = useState(false)

  const fetchProviders = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await apiFetch("/admin/providers")
      if (!resp.ok) throw new Error("failed")
      const data = await resp.json()
      setProviders((data.providers || []).map(mapProvider))
      setSupportedFormats((data.supportedFormats || []).map(mapSupportedFormat))
    } catch {
      setProviders([])
      setSupportedFormats([])
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
    if (form.transformsJson.trim()) {
      try {
        body.transforms = JSON.parse(form.transformsJson.trim())
      } catch (e) {
        setTestResult(t("test_failed", { error: "Invalid transforms JSON: " + (e as Error).message }))
        return
      }
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
    setForm({ id: "", protocol: "openai-compatible", baseUrl: "", authType: "bearer", testApiKey: "", chatEndpoint: "", transformsJson: "" })
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
      const config: any = {
        providerId: form.id || "test",
        protocol: form.protocol,
        baseUrl: form.baseUrl,
        authType: form.authType,
        chatEndpoint: form.chatEndpoint || undefined,
        models: [modelId],
        autoFetchModels: false,
      }
      if (form.transformsJson.trim()) {
        try { config.transforms = JSON.parse(form.transformsJson.trim()) } catch {}
      }
      const body: any = { apiKey: form.testApiKey, config }
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
      transformsJson: "",
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

  function loadProviderDetail(p: Provider) {
    setDetailProvider(p)
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
                      <Badge variant={p.source === "configured" ? "secondary" : "default"}>{t(p.source)}</Badge>
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
                    {p.source === "configured" && (
                      <Button variant="outline" size="sm" onClick={() => handleFetchModelsForSaved(p)}>
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => startEdit(p)} disabled={p.source !== "configured"}>
                      Edit
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => setDeleteTarget(p)} disabled={p.source !== "configured"}>
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Supported Formats Section */}
      <Card>
        <CardHeader>
          <CardTitle>🔌 {t("supported_formats_title") || "Supported Protocol Formats"}</CardTitle>
        </CardHeader>
        <CardContent>
          {supportedFormats.length === 0 ? (
            <p className="text-muted-foreground">No protocol formats available</p>
          ) : (
            <div className="space-y-2">
              {supportedFormats.map((f) => (
                <div key={f.providerId} className="flex items-center justify-between rounded-lg border border-border p-3 hover:bg-accent/30 transition-colors">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{f.providerName}</span>
                      <Badge variant="outline">{t("format")}</Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Protocol: {f.protocol} · ID: {f.providerId}
                    </div>
                    {f.capabilities && (
                      <div className="text-xs text-muted-foreground">
                        Capabilities: {Object.entries(f.capabilities)
                          .filter(([_, v]) => v === true)
                          .map(([k]) => k)
                          .join(", ")}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Custom Transforms Trigger */}
          <div className="mt-4 border-t border-border pt-4">
            <Button variant="outline" size="sm" onClick={() => setTransformsOpen(true)}>
              🛠️ {t("custom_transforms") || "Custom Protocol Transforms"}
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("transforms_hint") || "Declare how this provider deviates from the base protocol. Applied at runtime without code changes."}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Transforms Dialog */}
      <Dialog open={transformsOpen} onOpenChange={(v) => !v && setTransformsOpen(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>🛠️ {t("custom_transforms") || "Custom Protocol Transforms"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t("transforms_hint") || "Declare how this provider deviates from the base protocol. Applied at runtime without code changes."}
            </p>
            <textarea
              className="min-h-[200px] w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              placeholder={JSON.stringify({
                request: { wrap: "input", set: { temperature: 0.7 }, rename: { max_tokens: "maxTokens" } },
                response: { unwrap: "output", construct: { content: "text", model: "model_id" } },
                stream: { contentPath: "delta.text", doneMarker: "[DONE]" }
              }, null, 2)}
              value={form.transformsJson}
              onChange={(e) => setForm({ ...form, transformsJson: e.target.value })}
            />
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => {
                try {
                  JSON.parse(form.transformsJson.trim())
                  setTestResult("✅ Transforms JSON is valid")
                } catch (e: any) {
                  setTestResult(t("test_failed", { error: "Transforms JSON: " + e.message }))
                }
              }}>
                Validate JSON
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, transformsJson: "" })}>
                Clear
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setTransformsOpen(false)}>
                Done
              </Button>
            </div>
            {form.transformsJson.trim() && (
              <p className="text-xs text-muted-foreground">
                Transforms will be applied to {form.id || "this provider"} when saved.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>

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
