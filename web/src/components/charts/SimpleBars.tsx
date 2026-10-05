import { dayLabel } from "../../lib/format";

const W = 720, H = 140, L = 30, B = 22, T = 6;

/** Barres d'une seule série (appels par jour, par exemple), avec infobulles natives. */
export function SimpleBars({ data, unit }: { data: { day: string; value: number }[]; unit: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const top = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const n = Math.max(data.length, 1), slot = (W - L) / n, bw = Math.max(2, Math.min(16, slot * 0.66));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const labelAt = new Set([0, Math.floor((n - 1) / 2), n - 1]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={unit}>
      {[0, 1].map((f) => <g key={f}><line x1={L} x2={W} y1={y(top * f)} y2={y(top * f)} stroke="var(--line)" strokeDasharray={f ? "2 4" : undefined} /><text x={L - 6} y={y(top * f) + 3.5} textAnchor="end" className="fill-faint font-mono text-[10px]">{Math.round(top * f)}</text></g>)}
      {data.map((d, i) => (
        <g key={d.day}>
          <title>{`${dayLabel(d.day)} : ${d.value} ${unit}`}</title>
          <rect x={L + slot * i + (slot - bw) / 2} y={y(d.value)} width={bw} height={Math.max(0, y(0) - y(d.value))} rx={bw > 5 ? 2 : 0.5} fill="var(--accent)" className="grow" style={{ ["--i" as string]: i }} />
        </g>
      ))}
      {data.map((d, i) => labelAt.has(i) && <text key={d.day} x={L + slot * i + slot / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-faint font-mono text-[10px]">{dayLabel(d.day)}</text>)}
    </svg>
  );
}
