import clsx from "clsx";

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { value: T; label: string; count?: number }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex gap-1 rounded-xl border border-line bg-surface p-1">
      {items.map((i) => (
        <button key={i.value} role="tab" aria-selected={value === i.value} type="button" onClick={() => onChange(i.value)}
          className={clsx("rounded-lg px-3 py-1.5 text-[13px] font-medium transition", value === i.value ? "bg-ink text-paper" : "text-muted hover:text-ink")}>
          {i.label}{i.count !== undefined && <span className="tnum ml-1.5 opacity-60">{i.count}</span>}
        </button>
      ))}
    </div>
  );
}
