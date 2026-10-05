import type { ReactNode } from "react";

export type Seg = { label: string; value: number; color: string };

/** Anneau de répartition ; le centre affiche un total ou une valeur clé. */
export function Donut({ segments, center, sub }: { segments: Seg[]; center: ReactNode; sub?: string }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = 38, c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 100 100" className="size-36 shrink-0 -rotate-90" role="img" aria-label="Répartition des statuts">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--line)" strokeWidth="11" />
        {total > 0 && segments.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * c, el = (
            <circle key={s.label} cx="50" cy="50" r={r} fill="none" stroke={s.color} strokeWidth="11" strokeDasharray={`${Math.max(len - 1.5, 0.5)} ${c}`} strokeDashoffset={-offset}>
              <title>{`${s.label} : ${s.value}`}</title>
            </circle>
          );
          offset += len;
          return el;
        })}
        <g className="rotate-90 origin-center">
          <text x="50" y="52" textAnchor="middle" className="fill-ink font-display text-[20px] font-medium">{center}</text>
          {sub && <text x="50" y="64" textAnchor="middle" className="fill-muted font-mono text-[6px] uppercase tracking-widest">{sub}</text>}
        </g>
      </svg>
      <ul className="grid min-w-0 flex-1 gap-1.5 text-sm">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2"><span className="size-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden /><span className="min-w-0 flex-1 truncate text-muted">{s.label}</span><span className="tnum font-medium text-ink">{s.value}</span></li>
        ))}
      </ul>
    </div>
  );
}
