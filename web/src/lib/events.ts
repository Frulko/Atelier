import { useEffect, useState } from "react";
import type { TaskEvent } from "./types";

/**
 * Journal en direct d'une tâche (flux SSE). Le serveur rejoue l'historique puis suit le direct ; les doublons sont
 * ignorés par identifiant. Le flux se ferme avec la page (le serveur nettoie à la déconnexion).
 */
export function useTaskEvents(orgId: string, taskId: string) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    const es = new EventSource(`/api/orgs/${orgId}/tasks/${taskId}/events`);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as TaskEvent;
      if (e.type === "status") return; // simple signal de changement d'état : la requête de la tâche s'en charge
      setEvents((prev) => (prev.some((p) => p.id === e.id) ? prev : [...prev, e]));
    };
    return () => es.close();
  }, [orgId, taskId]);
  return events;
}
