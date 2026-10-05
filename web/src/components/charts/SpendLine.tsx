import { useId } from "react";
import { dayLabel, fmtUsd } from "../../lib/format";
import type { DayPoint } from "../../lib/types";

const W = 720, H = 180, L = 40, B = 24, T = 10, R = 8;

/** Courbe cumulée de la dépense sur la période, avec le plafond mensuel en pointillés quand il existe. */
export function SpendLine({ data, cap }: { data: DayPoint[]; cap?: number | null }) {
  const gid = useId();
  let acc = 0;
  const pts = data.map((d) => ({ day: d.day, v: (acc += d.spendUsd) }));
  const total = acc;
  const topRaw = Math.max(total, cap ?? 0, 1);
  const top = Math.ceil(topRaw * 1.1 * 10) / 10;
  const n = Math.max(pts.length - 1, 1);
  const x = (i: number) => L + ((W - L - R) * i) / n, y = (v: number) => T + (H - T - B) * (1 - v / top);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${y(0)} L${x(0)},${y(0)} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Dépense cumulée">
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - R} y1={y(top * f)} y2={y(top * f)} stroke="var(--line)" strokeDasharray={f === 0 ? undefined : "2 4"} />
          <text x={L - 6} y={y(top * f) + 3.5} textAnchor="end" className="fill-faint font-mono text-[10px]">{(top * f).toFixed(top < 10 ? 1 : 0)}</text>
        </g>
      ))}
      {cap != null && cap > 0 && <g><line x1={L} x2={W - R} y1={y(cap)} y2={y(cap)} stroke="var(--bad)" strokeDasharray="6 4" /><text x={W - R} y={y(cap) - 5} textAnchor="end" className="fill-bad font-mono text-[10px]">plafond {fmtUsd(cap)}</text></g>}
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" className="draw" style={{ ["--len" as string]: 2400 }} />
      {pts.length > 0 && <circle cx={x(pts.length - 1)} cy={y(total)} r="4" fill="var(--accent)"><title>{`Total : ${fmtUsd(total)}`}</title></circle>}
      {[0, pts.length - 1].map((i, k) => pts[i] && <text key={k} x={x(i)} y={H - 6} textAnchor={k === 0 ? "start" : "end"} className="fill-faint font-mono text-[10px]">{dayLabel(pts[i]!.day)}</text>)}
    </svg>
  );
}
