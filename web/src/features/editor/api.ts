import { api } from "../../lib/api";

export interface EditorSession { id: string; projectId: string; taskId: string | null; branch: string; baseBranch: string; createdAt: number; lastActive: number; expiresAt: number }
export interface Entry { name: string; path: string; type: "file" | "dir" | "link"; size: number }
export interface FileChange { path: string; status: "A" | "M" | "D" | "R"; from?: string; protected: boolean }
export interface Changes { files: FileChange[]; diff: string; truncated: boolean }
export interface CommitResult { files: number; flagged: string[]; mrUrl: string | null }

const base = (org: string, id: string) => `/api/orgs/${org}/editor/sessions/${id}`;
export const editorApi = {
  open: (org: string, projectId: string, taskId?: string) => api.post<EditorSession>(`/api/orgs/${org}/editor/sessions`, { projectId, taskId }),
  discard: (org: string, id: string) => api.del(base(org, id)),
  tree: (org: string, id: string, path: string) => api.get<{ entries: Entry[]; truncated: boolean }>(`${base(org, id)}/tree?path=${encodeURIComponent(path)}`),
  read: (org: string, id: string, path: string) => api.get<{ path: string; content: string; size: number }>(`${base(org, id)}/file?path=${encodeURIComponent(path)}`),
  save: (org: string, id: string, path: string, content: string, parents = false) => api.put<{ path: string; size: number }>(`${base(org, id)}/file`, { path, content, ...(parents ? { parents: true } : {}) }),
  op: (org: string, id: string, body: { op: "create"; path: string; type: "file" | "dir" } | { op: "rename"; from: string; to: string } | { op: "delete"; path: string }) => api.post(`${base(org, id)}/files`, body),
  search: (org: string, id: string, q: string) => api.get<{ paths: string[]; truncated: boolean }>(`${base(org, id)}/search?q=${encodeURIComponent(q)}`),
  changes: (org: string, id: string) => api.get<Changes>(`${base(org, id)}/diff`),
  check: (org: string, id: string) => api.post<{ ok: boolean; output: string }>(`${base(org, id)}/check`),
  commit: (org: string, id: string, message: string) => api.post<CommitResult>(`${base(org, id)}/commit`, { message }),
};
