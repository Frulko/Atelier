import clsx from "clsx";
import { AlertTriangle, Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { ApiError } from "../../lib/api";
import { Button } from "./Button";

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-lg bg-line/70", className)} aria-hidden />;
}

export function EmptyState({ title, hint, action, icon }: { title: string; hint?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="grid place-items-center gap-3 rounded-xl border border-dashed border-line-strong px-6 py-14 text-center">
      <div className="grid size-12 place-items-center rounded-full bg-line/60 text-muted">{icon ?? <Inbox className="size-5" aria-hidden />}</div>
      <p className="font-display text-lg text-ink">{title}</p>
      {hint && <p className="max-w-md text-sm text-muted">{hint}</p>}
      {action}
    </div>
  );
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Une erreur est survenue.");

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="flex items-start gap-3 rounded-xl border border-bad/30 bg-bad-soft p-4 text-sm text-bad">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="grid gap-2"><p>{errorText(error)}</p>{retry && <Button size="sm" variant="secondary" onClick={retry}>Réessayer</Button>}</div>
    </div>
  );
}

/** Message d'erreur sous un formulaire. */
export const FormError = ({ error }: { error: unknown }) => (error ? <p role="alert" className="text-sm font-medium text-bad">{errorText(error)}</p> : null);
