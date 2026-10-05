import clsx from "clsx";
import type { ReactNode } from "react";
import { ROLE_LABEL } from "../../lib/roles";
import { STATUS_LABEL, STATUS_TONE, type Tone } from "../../lib/labels";
import type { Role, Status } from "../../lib/types";

const tones: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad",
  info: "bg-info-soft text-info", accent: "bg-accent-soft text-accent", muted: "bg-line/70 text-muted",
};

export function Badge({ tone = "muted", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium", tones[tone], className)}>{children}</span>;
}

/** Statut d'une tâche : un point (qui pulse tant que ça travaille) et un libellé. */
export function StatusPill({ status }: { status: Status }) {
  const tone = STATUS_TONE[status];
  return (
    <Badge tone={tone}>
      <span className={clsx("size-1.5 rounded-full bg-current", status === "running" && "pulse")} aria-hidden />
      {STATUS_LABEL[status]}
    </Badge>
  );
}

export const RoleBadge = ({ role }: { role: Role }) => <Badge tone={role === "owner" ? "accent" : role === "admin" ? "info" : "muted"}>{ROLE_LABEL[role]}</Badge>;
