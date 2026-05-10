import { useState } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { t, setLang, getLang } from "@/lib/i18n"
import { setAdminToken } from "@/lib/api"
import ProvidersPanel from "@/components/ProvidersPanel"
import KeysPanel from "@/components/KeysPanel"

export default function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [lang, setLangState] = useState(getLang())
  const [tab, setTab] = useState("providers")

  function toggleLang() {
    const next = lang === "en" ? "zh" : "en"
    setLang(next)
    setLangState(next)
  }

  function handleLogout() {
    setAdminToken("")
    onLogout()
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div>
            <h1 className="text-xl font-bold text-primary">{t("admin_title")}</h1>
            <p className="text-xs text-muted-foreground">{t("admin_subtitle")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={toggleLang}>
              {lang === "en" ? "🇨🇳" : "🇺🇸"}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              {t("logout")}
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="providers">{t("tab_providers")}</TabsTrigger>
            <TabsTrigger value="keys">{t("tab_keys")}</TabsTrigger>
          </TabsList>
          <TabsContent value="providers">
            <ProvidersPanel />
          </TabsContent>
          <TabsContent value="keys">
            <KeysPanel />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  )
}
