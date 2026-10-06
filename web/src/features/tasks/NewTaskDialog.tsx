import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ShieldAlert, TerminalSquare } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Select, Textarea } from "../../components/ui/Field";
import { FormError } from "../../components/ui/Feedback";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { invalidateOrg, projectsQuery } from "../../lib/queries";
import { useOrg } from "../../lib/useOrg";
import type { Task } from "../../lib/types";

export function NewTaskDialog({ open, onClose, defaultProject }: { open: boolean; onClose: () => void; defaultProject?: string }) {
  const { orgId } = useOrg();
  const projects = useQuery(projectsQuery(orgId));
  const navigate = useNavigate();
  const toast = useToast();
  const [project, setProject] = useState(defaultProject ?? "");
  const [prompt, setPrompt] = useState("");

  useEffect(() => { if (open) setProject((p) => p || defaultProject || projects.data?.[0]?.id || ""); }, [open, defaultProject, projects.data]);
  const chosen = projects.data?.find((p) => p.id === project);

  const create = useMutation({
    mutationFn: () => api.post<Task>(`/api/orgs/${orgId}/tasks`, { project, prompt }),
    onSuccess: (t) => {
      invalidateOrg(orgId, "tasks"); invalidateOrg(orgId, "stats"); invalidateOrg(orgId, "conversations"); invalidateOrg(orgId, "status");
      setPrompt(""); onClose(); toast("Tâche lancée : l'agent s'y met.");
      navigate({ to: "/o/$orgId/tasks/$taskId", params: { orgId, taskId: t.id } });
    },
  });

  return (
    <Dialog open={open} onClose={onClose} wide title="Nouvelle tâche" description="Décris le changement souhaité en français. L'agent travaille dans un bac à sable et prépare une proposition à relire.">
      <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="grid gap-4">
        <Field label="Projet" error={projects.data?.length === 0 ? "Aucun projet : un administrateur doit en créer un." : null}>
          {(id) => <Select id={id} value={project} onChange={(e) => setProject(e.target.value)} required>{projects.data?.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>}
        </Field>
        {chosen && (
          <ul className="grid gap-1.5 rounded-xl bg-line/40 px-3.5 py-3 text-xs text-muted">
            <li className="flex items-start gap-2"><TerminalSquare className="mt-0.5 size-3.5 shrink-0" aria-hidden />Vérification automatique : <code className="font-mono text-ink">{chosen.check}</code></li>
            {chosen.protectedPaths.length > 0 && <li className="flex items-start gap-2"><ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warn" aria-hidden />Relecture obligatoire si ces chemins changent : <code className="font-mono text-ink">{chosen.protectedPaths.join(", ")}</code></li>}
          </ul>
        )}
        <Field label="Ta demande" hint="Précise l'endroit et le résultat attendu. Exemple : « Ajoute un tarif dégressif sur l'onglet Voyage au-delà de 20 repas ».">
          {(id) => <Textarea id={id} value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} required autoFocus maxLength={20000} />}
        </Field>
        <FormError error={create.error} />
        <div className="flex justify-end gap-2"><Button onClick={onClose}>Annuler</Button><Button variant="primary" type="submit" loading={create.isPending} disabled={!project || !prompt.trim()}>Lancer la tâche</Button></div>
      </form>
    </Dialog>
  );
}
