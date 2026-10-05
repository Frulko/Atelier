import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>) {
  return <div className={clsx("rounded-xl border border-line bg-surface shadow-card", className)} {...p} />;
}

/** Section d'une page : étiquette en monospace, filet double, contenu. */
export function Section({ title, hint, actions, children, className, index = 0 }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; index?: number }) {
  return (
    <section className={clsx("rise", className)} style={{ ["--i" as string]: index }}>
      <header className="mb-3 flex items-end justify-between gap-4 pb-1">
        <div>
          <h2 className="label">{title}</h2>
          {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="rise mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl leading-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-[15px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Stat({ label, value, sub, tone, index = 0 }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "ok" | "bad" | "accent"; index?: number }) {
  return (
    <Card className="rise p-5" style={{ ["--i" as string]: index }}>
      <p className="label">{label}</p>
      <p className={clsx("tnum font-display mt-2 text-3xl leading-none", tone === "ok" && "text-ok", tone === "bad" && "text-bad", tone === "accent" && "text-accent")}>{value}</p>
      {sub && <p className="mt-2 text-[13px] text-muted">{sub}</p>}
    </Card>
  );
}
