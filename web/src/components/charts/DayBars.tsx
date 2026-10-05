import { dayLabel } from "../../lib/format";
import type { DayPoint } from "../../lib/types";

const W = 720, H = 200, L = 30, B = 24, T = 8;

/** Barres empilées par jour : réussies, échecs, autres. Les infobulles natives (<title>) donnent le détail. */
export function DayBars({ data }: { data: DayPoint[] }) {
  const max = Math.max(1, ...data.map((d) => d.tasks));
  const top = max <= 4 ? max : Math.ceil(max / 4) * 4;
  const n = Math.max(data.length, 1), slot = (W - L) / n, bw = Math.max(2, Math.min(18, slot * 0.68));
  const y = (v: number) => T + (H - T - B) * (1 - v / top);
  const labelAt = new Set([0, Math.floor((n - 1) / 2), n - 1]);
  const empty = data.every((d) => d.tasks === 0);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Tâches par jour">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W} y1={y(top * f)} y2={y(top * f)} stroke="var(--line)" strokeDasharray={f === 0 ? undefined : "2 4"} />
          <text x={L - 6} y={y(top * f) + 3.5} textAnchor="end" className="fill-faint font-mono text-[10px]">{Math.round(top * f)}</text>
        </g>
      ))}
      {data.map((d, i) => {
        const x = L + slot * i + (slot - bw) / 2, other = Math.max(0, d.tasks - d.done - d.failed);
        const segs: [number, string][] = [[d.done, "var(--ok)"], [d.failed, "var(--bad)"], [other, "var(--line-strong)"]];
        let acc = 0;
        return (
          <g key={d.day} className="grow" style={{ ["--i" as string]: i }}>
            <title>{`${dayLabel(d.day)} : ${d.tasks} tâche${d.tasks > 1 ? "s" : ""} (${d.done} réussie${d.done > 1 ? "s" : ""}, ${d.failed} échec${d.failed > 1 ? "s" : ""})`}</title>
            <rect x={x} y={T} width={bw} height={H - T - B} fill="transparent" />
            {segs.map(([v, c], k) => { if (!v) return null; const h = y(acc) - y(acc + v); acc += v; return <rect key={k} x={x} y={y(acc)} width={bw} height={h} rx={bw > 5 ? 2 : 0.5} fill={c} />; })}
          </g>
        );
      })}
      {data.map((d, i) => labelAt.has(i) && (
        <text key={d.day} x={L + slot * i + slot / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} className="fill-faint font-mono text-[10px]">{dayLabel(d.day)}</text>
      ))}
      {empty && <text x={(W + L) / 2} y={H / 2} textAnchor="middle" className="fill-muted text-[13px]">Aucune tâche sur cette période</text>}
    </svg>
  );
}
