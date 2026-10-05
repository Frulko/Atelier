export type Role = "owner" | "admin" | "member" | "viewer";
export type Status = "queued" | "running" | "done" | "no_changes" | "failed" | "cancelled";

export interface OrgRef { id: string; name: string; role: Role }
export interface Me { user: { id: string; email: string; name: string | null }; orgs: OrgRef[] }

export interface Task {
  id: string; org_id: string; user_id: string | null; project: string; project_name: string | null; user_email: string | null;
  prompt: string; status: Status; branch: string | null; mr_url: string | null; cost: number;
  created_at: number; started_at: number | null; finished_at: number | null; files_json: string | null; flagged: number; turn: number; followup: string | null;
}
export interface TaskPage { items: Task[]; total: number; limit: number; offset: number }
export interface TaskEvent { id: number; task_id: string; ts: number; type: string; text: string; turn?: number }
export interface TaskFilters { status?: string; project?: string; user?: string; q?: string; from?: number; to?: number }

export interface Project {
  id: string; slug: string; name: string; repo: string; branch: string; forge: "gitlab" | "github" | "none";
  check: string; engine: string; protectedPaths: string[]; gitSecretId: string | null;
}
export interface AccessCheck { ok: boolean; branchFound: boolean; error?: "auth" | "not_found" | "timeout" | "unreachable"; detail?: string; ms: number }

export interface Secret {
  id: string; kind: "git_token" | "provider_key"; provider: string | null; label: string; hint: string;
  created_at: number; last_used_at: number | null; usedBy: { id: string; name: string }[];
}
export interface Member { userId: string; email: string; role: Role }
export interface Invitation { id: string; email: string; role: Role; created_at: number; expires_at: number }
export interface NewInvitation { id: string; email: string; role: Role; expiresAt: number; token: string }

export interface DayPoint { day: string; tasks: number; done: number; failed: number; spendUsd: number; calls?: number }
export interface ProjectStat { id: string; name: string; tasks: number; done: number; failed: number; spendUsd: number }
export interface Stats {
  range: { days: number; from: number; to: number };
  totals: { tasks: number; byStatus: Record<Status, number>; successRate: number | null; avgDurationMs: number | null; spendUsd: number };
  perDay: DayPoint[]; byProject: ProjectStat[];
}
export interface Usage {
  range: { days: number; from: number; to: number };
  perDay: DayPoint[]; byProject: ProjectStat[];
  byMember: { userId: string; email: string; tasks: number; done: number; failed: number; spendUsd: number }[];
  byProvider: { provider: string; calls: number; errors: number }[];
  budget: { capUsd: number | null; monthSpendUsd: number; projectedMonthUsd: number };
}
export interface OrgDetail { id: string; name: string; budgetUsdMonth: number | null; monthSpendUsd: number }

export interface AuditItem {
  id: number; ts: number; action: string; userId: string | null; userEmail: string | null;
  targetType: string | null; targetId: string | null; meta: Record<string, unknown> | null; ip: string | null;
}
export interface AuditPage { items: AuditItem[]; total: number; limit: number; offset: number }
export interface AuditFilters { action?: string; user?: string; q?: string; from?: number; to?: number }

export interface KnowledgeBrief {
  id: string; projectId: string | null; title: string; excerpt: string; chars: number; enabled: boolean; pinned: boolean;
  author: string | null; createdAt: number; updatedAt: number;
}
export interface KnowledgeItem extends Omit<KnowledgeBrief, "excerpt" | "chars"> { content: string }
export interface KnowledgePreview {
  chosen: { id: string; title: string; projectId: string | null; chars: number; pinned: boolean }[];
  omitted: { id: string; title: string; projectId: string | null; chars: number; pinned: boolean }[];
  chars: number; budget: number;
}

export interface Session { id: string; createdAt: number; lastUsedAt: number; expiresAt: number; userAgent: string | null; ip: string | null; current: boolean }
export interface Activity { id: number; ts: number; action: string; orgId: string | null; orgName: string | null; meta: Record<string, unknown> | null; ip: string | null }

export interface Conversation {
  id: string; mode: "chat" | "task"; title: string; projectId: string | null; projectName: string | null; userId: string; userEmail: string | null;
  taskId: string | null; parentId: string | null; messageCount: number; preview: string; createdAt: number; updatedAt: number;
}
export interface ConversationPage { items: Conversation[]; total: number; limit: number; offset: number }
export interface ChatSource { id: string; title: string }
export interface ConversationDetail { conversation: Conversation; messages: import("ai").UIMessage<{ sources?: ChatSource[]; model?: string }>[]; task: Task | null }
