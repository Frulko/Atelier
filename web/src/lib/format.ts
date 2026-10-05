const DAY = 86_400_000;

export const fmtDate = (ms: number) => new Date(ms).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
export const fmtDateTime = (ms: number) => `${fmtDate(ms)} · ${fmtTime(ms)}`;

/** « il y a 3 min », « hier », « dans 2 j » — pour les listes où l'instant exact compte moins que la fraîcheur. */
export function relTime(ms: number, now = Date.now()): string {
  const d = ms - now, a = Math.abs(d);
  const unit = (n: number, u: string) => (d < 0 ? `il y a ${n} ${u}` : `dans ${n} ${u}`);
  if (a < 45_000) return d < 0 ? "à l'instant" : "dans un instant";
  if (a < 3_600_000) return unit(Math.round(a / 60_000), "min");
  if (a < DAY) return unit(Math.round(a / 3_600_000), "h");
  if (a < 2 * DAY) return d < 0 ? "hier" : "demain";
  if (a < 30 * DAY) return unit(Math.round(a / DAY), "j");
  return fmtDate(ms);
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

export const fmtUsd = (n: number | null | undefined) => (n == null ? "—" : `${n.toFixed(2).replace(".", ",")} $`);
export const fmtPct = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)} %`);
export const fmtInt = (n: number) => n.toLocaleString("fr-FR");

/** « 2026-10-05 » (jour UTC du serveur) → « 5 oct. » */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
}

export function initials(nameOrEmail: string | null | undefined): string {
  const base = (nameOrEmail ?? "?").split("@")[0]!.replace(/[._-]+/g, " ").trim();
  const parts = base.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0]! : "")).toUpperCase();
}

export function parseFiles(json: string | null): string[] {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** Bornes (ms, UTC) d'un intervalle saisi en dates « AAAA-MM-JJ » : le jour de fin est inclus. */
export function dayRange(from?: string, to?: string): { from?: number; to?: number } {
  const t = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) : undefined);
  const f = t(from), e = t(to);
  return { from: f, to: e === undefined ? undefined : e + DAY };
}
