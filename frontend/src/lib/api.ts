const API_BASE = "";

export function getAdminToken(): string {
  return localStorage.getItem("llmhub_admin_token") || "";
}

export function setAdminToken(token: string) {
  localStorage.setItem("llmhub_admin_token", token);
}

export function removeAdminToken() {
  localStorage.removeItem("llmhub_admin_token");
}

export async function apiFetch(path: string, opts?: RequestInit) {
  const token = getAdminToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(opts?.headers as Record<string, string> || {}),
  };

  const resp = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers,
  });

  if (resp.status === 401) {
    removeAdminToken();
    window.location.reload();
    throw new Error("Unauthorized");
  }

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error?.message || `HTTP ${resp.status}`);
  }

  return resp.json();
}
