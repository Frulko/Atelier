import { createContext, useContext } from "react";
import type { Project } from "../../lib/types";

/** Ce que les pages d'un projet partagent : le projet, et les deux dialogues que le gabarit possède. */
export const ProjectCtx = createContext<{ project: Project; openNew: () => void; openEdit: () => void } | null>(null);
export function useProject() {
  const c = useContext(ProjectCtx);
  if (!c) throw new Error("useProject hors d'un projet");
  return c;
}
