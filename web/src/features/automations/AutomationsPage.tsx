import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bot, Clock3, Pause, Play, Plus, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader } from "../../components/ui/Card";
import { Dialog } from "../../components/ui/Dialog";
import { Field, Input, Select, Textarea } from "../../components/ui/Field";
import {
  EmptyState,
  ErrorBox,
  FormError,
  Skeleton,
} from "../../components/ui/Feedback";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { api } from "../../lib/api";
import {
  automationsQuery,
  invalidateOrg,
  projectsQuery,
} from "../../lib/queries";
import { fmtDateTime as fmtDate } from "../../lib/format";
import { useOrg } from "../../lib/useOrg";
import type { Automation } from "../../lib/types";

export function AutomationsPage() {
  const { orgId } = useOrg(),
    q = useQuery(automationsQuery(orgId));
  const [edit, setEdit] = useState<Automation | null | undefined>();
  const action = useMutation({
    mutationFn: ({ a, op }: { a: Automation; op: string }) =>
      op === "delete"
        ? api.del(`/api/orgs/${orgId}/automations/${a.id}`)
        : op === "run"
          ? api.post(`/api/orgs/${orgId}/automations/${a.id}/run`)
          : api.patch(`/api/orgs/${orgId}/automations/${a.id}`, {
              enabled: !a.enabled,
            }),
    onSuccess: () => {
      invalidateOrg(orgId, "automations");
      invalidateOrg(orgId, "tasks");
    },
  });
  const active = q.data?.filter((a) => a.enabled).length ?? 0;
  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="Des missions qui avancent côté serveur, à heure fixe ou de façon autonome."
        actions={
          <Button
            variant="primary"
            icon={<Plus className="size-4" />}
            onClick={() => setEdit(null)}
          >
            Nouvel agent
          </Button>
        }
      />
      <div className="mb-7 grid gap-4 sm:grid-cols-3">
        {[
          ["Agents actifs", active],
          ["Planifiés", q.data?.filter((a) => a.kind === "cron").length ?? 0],
          [
            "Autonomes",
            q.data?.filter((a) => a.kind === "autonomous").length ?? 0,
          ],
        ].map(([label, value]) => (
          <Card key={label} className="p-5">
            <p className="label">{label}</p>
            <p className="mt-2 font-display text-3xl tnum">{value}</p>
          </Card>
        ))}
      </div>
      <p className="mb-5 text-sm text-muted">
        Tu peux fermer Atelier. Chaque agent respecte le budget de
        l'organisation, évite les exécutions simultanées sur son projet et se
        met en pause après un échec.
      </p>
      <FormError error={action.error} />
      {q.isPending ? (
        <Skeleton className="h-48" />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : !q.data.length ? (
        <EmptyState
          icon={<Bot className="size-5" />}
          title="Confie une mission à un agent"
          hint="Par exemple : vérifier chaque matin la page de contact, ou améliorer progressivement l'accessibilité d'un projet."
          action={
            <Button onClick={() => setEdit(null)}>
              Créer le premier agent
            </Button>
          }
        />
      ) : (
        <ul className="grid gap-4">
          {q.data.map((a) => (
            <li key={a.id}>
              <Card className="p-5 sm:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <Badge tone={a.enabled ? "ok" : "muted"}>
                        {a.enabled ? "Actif" : "En pause"}
                      </Badge>
                      <Badge tone="info">
                        {a.kind === "cron" ? "Planifié" : "Autonome"}
                      </Badge>
                      <span className="text-xs text-muted">
                        {a.project_name}
                      </span>
                    </div>
                    <h2 className="font-display text-xl">{a.name}</h2>
                    <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-muted">
                      {a.prompt}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`Modifier ${a.name}`}
                      icon={<Pencil className="size-4" />}
                      onClick={() => setEdit(a)}
                    />
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      aria-label={`Supprimer ${a.name}`}
                      icon={<Trash2 className="size-4" />}
                      onConfirm={() => action.mutate({ a, op: "delete" })}
                    >
                      Supprimer
                    </ConfirmButton>
                  </div>
                </div>
                <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-4 text-xs text-muted">
                  <span className="flex items-center gap-1.5">
                    <Clock3 className="size-3.5" />
                    {a.kind === "cron"
                      ? `${a.cron} · ${a.timezone}`
                      : `Toutes les ${a.interval_minutes} min`}
                  </span>
                  <span>{a.max_runs_day} exécutions / jour UTC au plus</span>
                  {a.enabled > 0 && (
                    <span>Prochain passage : {fmtDate(a.next_run_at)}</span>
                  )}
                  {a.last_task_id && (
                    <Link
                      to="/o/$orgId/tasks/$taskId"
                      params={{ orgId, taskId: a.last_task_id }}
                      className="text-accent hover:underline"
                    >
                      Dernière exécution
                    </Link>
                  )}
                  <div className="ml-auto flex gap-2">
                    <Button
                      size="sm"
                      icon={
                        a.enabled ? (
                          <Pause className="size-3.5" />
                        ) : (
                          <Play className="size-3.5" />
                        )
                      }
                      onClick={() => action.mutate({ a, op: "toggle" })}
                    >
                      {a.enabled ? "Mettre en pause" : "Reprendre"}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => action.mutate({ a, op: "run" })}
                      loading={action.isPending}
                    >
                      Exécuter
                    </Button>
                  </div>
                </div>
                {a.last_error && (
                  <p
                    role="status"
                    className="mt-3 rounded-md bg-warn-soft px-3 py-2 text-sm text-warn"
                  >
                    {a.last_error}
                  </p>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={edit !== undefined}
        onClose={() => setEdit(undefined)}
        title={edit ? "Modifier l'agent" : "Nouvel agent"}
        wide
      >
        {edit !== undefined && (
          <AutomationForm
            key={edit?.id ?? "new"}
            existing={edit ?? undefined}
            onDone={() => setEdit(undefined)}
          />
        )}
      </Dialog>
    </>
  );
}
function AutomationForm({
  existing,
  onDone,
}: {
  existing?: Automation;
  onDone: () => void;
}) {
  const { orgId } = useOrg(),
    projects = useQuery(projectsQuery(orgId));
  const [name, setName] = useState(existing?.name ?? ""),
    [project, setProject] = useState(existing?.project_id ?? ""),
    [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [kind, setKind] = useState(existing?.kind ?? "cron"),
    [cron, setCron] = useState(existing?.cron ?? "0 9 * * 1-5"),
    [timezone, setTimezone] = useState(
      existing?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  const [interval, setInterval] = useState(existing?.interval_minutes ?? 60),
    [max, setMax] = useState(existing?.max_runs_day ?? 4);
  const save = useMutation({
    mutationFn: () => {
      const data = {
        name,
        project_id: project,
        prompt,
        kind,
        cron,
        timezone,
        interval_minutes: interval,
        max_runs_day: max,
        enabled: existing?.enabled ?? 1,
      };
      return existing
        ? api.patch(`/api/orgs/${orgId}/automations/${existing.id}`, data)
        : api.post(`/api/orgs/${orgId}/automations`, data);
    },
    onSuccess: () => {
      invalidateOrg(orgId, "automations");
      onDone();
    },
  });
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field label="Nom de l'agent">
        {(id) => (
          <Input
            id={id}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            placeholder="Le gardien de mon site"
          />
        )}
      </Field>
      <Field label="Projet">
        {(id) => (
          <Select
            id={id}
            value={project}
            onChange={(e) => setProject(e.target.value)}
            required
          >
            <option value="">Choisir un projet</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label="Mission"
        hint="Un objectif concret et ses critères de réussite. L'agent conserve les mêmes limites que les tâches manuelles."
      >
        {(id) => (
          <Textarea
            id={id}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            required
            maxLength={20000}
            rows={4}
            placeholder="Vérifie la page de contact, corrige les erreurs et ajoute un test pour chaque correction."
          />
        )}
      </Field>
      <Field label="Déclenchement">
        {(id) => (
          <Select
            id={id}
            value={kind}
            onChange={(e) => setKind(e.target.value as Automation["kind"])}
          >
            <option value="cron">Planifié : aux horaires choisis</option>
            <option value="autonomous">
              Autonome : poursuit sa mission sur la même proposition
            </option>
          </Select>
        )}
      </Field>
      {kind === "cron" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Expression cron"
            hint="Exemple : 0 9 * * 1-5 = à 9 h en semaine."
          >
            {(id) => (
              <Input
                id={id}
                value={cron}
                onChange={(e) => setCron(e.target.value)}
                required
                className="font-mono"
              />
            )}
          </Field>
          <Field label="Fuseau horaire">
            {(id) => (
              <Input
                id={id}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                required
              />
            )}
          </Field>
        </div>
      ) : (
        <Field
          label="Intervalle entre les passages (minutes)"
          hint="L'agent s'arrête après un échec, quand il n'a plus de changement à faire ou après dix tours."
        >
          {(id) => (
            <Input
              id={id}
              type="number"
              min={5}
              max={10080}
              value={interval}
              onChange={(e) => setInterval(Number(e.target.value))}
            />
          )}
        </Field>
      )}
      <Field label="Maximum d'exécutions par jour UTC">
        {(id) => (
          <Input
            id={id}
            type="number"
            min={1}
            max={100}
            value={max}
            onChange={(e) => setMax(Number(e.target.value))}
          />
        )}
      </Field>
      <FormError error={save.error} />
      <div className="flex justify-end">
        <Button type="submit" variant="primary" loading={save.isPending}>
          {existing ? "Enregistrer" : "Créer l'agent"}
        </Button>
      </div>
    </form>
  );
}
