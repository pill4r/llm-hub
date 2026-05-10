import { useState, useEffect } from "react"
import Login from "@/pages/Login"
import Dashboard from "@/pages/Dashboard"
import { getAdminToken } from "@/lib/api"

export default function App() {
  const [authed, setAuthed] = useState(false)

  useEffect(() => {
    if (getAdminToken()) setAuthed(true)
  }, [])

  if (!authed) {
    return (
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center">
        <Login onLogin={() => setAuthed(true)} />
      </div>
    )
  }

  return <Dashboard onLogout={() => setAuthed(false)} />
}
