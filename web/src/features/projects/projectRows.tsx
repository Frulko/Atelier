import { Link } from "@tanstack/react-router";
import { BookOpen, ListChecks, MessageSquare, Pin } from "lucide-react";
import { Avatar } from "../../components/ui/Avatar";
import { Badge, StatusPill } from "../../components/ui/Badge";
import { fmtUsd, relTime } from "../../lib/format";
import { ScopedLink } from "../../components/ui/ScopedLink";
import { useScope } from "../../lib/scope";
import type { Conversation, KnowledgeBrief, Task } from "../../lib/types";

export function TaskRows({ items }: { items: Task[]; orgId?: string }) {
  const scope = useScope();
  return (
    <ul className="divide-y divide-line">
      {items.map((t) => (
        <li key={t.id}><ScopedLink dest={scope.task(t.id)} className="group flex items-center gap-3 px-4 py-3 transition hover:bg-line/40">
          <Avatar name={t.user_email} size={26} />
          <div className="min-w-0 flex-1"><p className="truncate text-[15px] group-hover:text-accent">{t.prompt}</p><p className="text-xs text-muted">{t.user_email ?? "—"} · {relTime(t.created_at)}{t.cost ? ` · ${fmtUsd(t.cost)}` : ""}{t.turn > 1 ? ` · ${t.turn - 1} ajustement${t.turn > 2 ? "s" : ""}` : ""}</p></div>
          <StatusPill status={t.status} />
        </ScopedLink></li>
      ))}
    </ul>
  );
}

export function ConversationRows({ items }: { items: Conversation[]; orgId?: string }) {
  const scope = useScope();
  return (
    <ul className="divide-y divide-line">
      {items.map((c) => (
        <li key={c.id}><ScopedLink dest={scope.conversation(c.id)} className="group flex items-start gap-3 px-4 py-3 transition hover:bg-line/40">
          {c.mode === "chat" ? <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden /> : <ListChecks className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />}
          <div className="min-w-0 flex-1"><p className="truncate text-[15px] group-hover:text-accent">{c.title}</p>{c.preview && <p className="truncate text-[13px] text-muted">{c.preview}</p>}</div>
          <div className="shrink-0 text-right"><Badge>{c.mode === "chat" ? "Discussion" : "Tâche"}</Badge><p className="mt-1 text-xs text-faint">{relTime(c.updatedAt)}</p></div>
        </ScopedLink></li>
      ))}
    </ul>
  );
}

export function KnowledgeRows({ items, projectId }: { items: KnowledgeBrief[]; projectId: string }) {
  return (
    <ul className="divide-y divide-line">
      {items.map((k) => (
        <li key={k.id} className="flex items-start gap-3 px-4 py-3">
          <BookOpen className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className={`truncate text-[15px] ${k.enabled ? "" : "text-muted line-through"}`}>{k.title}</p>
            <p className="line-clamp-2 text-[13px] text-muted">{k.excerpt}</p>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
            <Badge tone={k.projectId === projectId ? "accent" : "muted"}>{k.projectId === projectId ? "Ce projet" : "Toute l'organisation"}</Badge>
            {k.pinned && <Badge tone="info"><Pin className="mr-1 inline size-3" aria-hidden />Épinglée</Badge>}
            {!k.enabled && <Badge tone="warn">Désactivée</Badge>}
          </div>
        </li>
      ))}
    </ul>
  );
}
