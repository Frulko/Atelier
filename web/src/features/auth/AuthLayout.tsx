import type { ReactNode } from "react";
import { Logo } from "../../components/layout/Logo";

/** Page d'entrée : un panneau d'encre avec la promesse du produit, et le formulaire sur le papier. */
export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden border-r border-line bg-side p-12 text-side-ink lg:flex lg:flex-col lg:justify-between">
        <div className="flex items-center gap-3"><Logo className="size-9" /><span className="font-display text-xl">Atelier</span></div>
        <div className="relative z-10">
          <p className="label">Une plateforme, un garde-fou</p>
          <h2 className="font-display mt-4 max-w-md text-[3rem] leading-[1.05]">Demande. L'agent propose. <em className="text-accent not-italic">Tu valides.</em></h2>
          <p className="mt-6 max-w-sm text-[15px] leading-relaxed text-side-muted">Chaque modification passe par un bac à sable jetable, sans secret ni Internet, puis arrive en proposition à relire. Rien n'est livré sans un humain.</p>
        </div>
        <ul className="relative z-10 grid gap-2.5 text-sm text-side-muted">
          {["clone du projet", "agent dans un bac à sable", "vérification automatique", "merge request à relire"].map((s, i) => (
            <li key={s} className="rise flex items-center gap-3" style={{ ["--i" as string]: i + 3 }}><span className="grid size-5 place-items-center rounded-full border border-side-line text-[10px]">{i + 1}</span>{s}</li>
          ))}
        </ul>
        <svg className="pointer-events-none absolute -right-24 -top-24 size-[34rem] text-ink/[0.06]" viewBox="0 0 200 200" aria-hidden>
          {Array.from({ length: 9 }).map((_, i) => <circle key={i} cx="100" cy="100" r={10 + i * 11} fill="none" stroke="currentColor" strokeWidth="1" />)}
        </svg>
      </aside>
      <main className="grid place-items-center px-6 py-14">
        <div className="rise w-full max-w-sm">
          <div className="mb-8 flex items-center gap-2.5 lg:hidden"><Logo /><span className="font-display text-lg">Atelier</span></div>
          <h1 className="font-display text-3xl leading-tight">{title}</h1>
          {subtitle && <p className="mt-2 text-[15px] text-muted">{subtitle}</p>}
          <div className="mt-8">{children}</div>
        </div>
      </main>
    </div>
  );
}
