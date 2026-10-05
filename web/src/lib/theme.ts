import { useSyncExternalStore } from "react";

export type Theme = "system" | "light" | "dark";
const KEY = "atelier-theme";
const listeners = new Set<() => void>();

function read(): Theme {
  try { const v = localStorage.getItem(KEY); if (v === "light" || v === "dark") return v; } catch { /* stockage indisponible */ }
  return "system";
}
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") root.removeAttribute("data-theme"); else root.setAttribute("data-theme", t);
}
export function setTheme(t: Theme) {
  try { if (t === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, t); } catch { /* idem */ }
  applyTheme(t);
  listeners.forEach((l) => l());
}
export const initTheme = () => applyTheme(read());
export const useTheme = () => useSyncExternalStore((cb) => { listeners.add(cb); return () => listeners.delete(cb); }, read, () => "system" as Theme);
