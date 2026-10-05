import type { ReactNode } from "react";

/** Liste de barres horizontales : un libellé, une valeur, et une barre proportionnelle au maximum. */
export function HBars({ rows, empty = "Rien à afficher." }: { rows: { key: string; label: ReactNode; value: number; display: ReactNode; sub?: ReactNode }[]; empty?: string }) {
  const max = Math.max(1e-9, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted">{empty}</p>;
  return (
    <ul className="grid gap-3">
      {rows.map((r, i) => (
        <li key={r.key} className="rise" style={{ ["--i" as string]: i }}>
          <div className="flex items-baseline justify-between gap-3 text-sm"><span className="min-w-0 truncate text-ink">{r.label}</span><span className="tnum shrink-0 font-medium text-ink">{r.display}</span></div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} /></div>
          {r.sub && <div className="mt-1 text-xs text-muted">{r.sub}</div>}
        </li>
      ))}
    </ul>
  );
}
