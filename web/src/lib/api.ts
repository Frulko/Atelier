export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** Appel JSON vers l'API. Une erreur du serveur devient une ApiError portant son message (déjà rédigé en français). */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  // Session expirée ou révoquée ailleurs : l'application renvoie vers la connexion (voir main.tsx).
  if (res.status === 401 && path !== "/api/auth/login" && path !== "/api/me") window.dispatchEvent(new Event("atelier:unauthorized"));
  if (!res.ok) throw new ApiError((data as { error?: string } | null)?.error ?? `Erreur ${res.status}`, res.status);
  return data as T;
}
const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return null; } };

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T = { ok: true }>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};

/** Construit une chaîne de requête en ignorant les valeurs vides. */
export function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}
