import { useMutation, useQuery } from "@tanstack/react-query";
import { ExternalLink, Globe2, Play, RotateCcw, Rocket } from "lucide-react";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Dialog } from "../../components/ui/Dialog";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, Section } from "../../components/ui/Card";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { Field, Input, Select } from "../../components/ui/Field";
import {
  EmptyState,
  ErrorBox,
  FormError,
  Skeleton,
} from "../../components/ui/Feedback";
import { api } from "../../lib/api";
import {
  environmentQuery,
  invalidateOrg,
  releasesQuery,
  runtimeQuery,
} from "../../lib/queries";
import { fmtDate } from "../../lib/format";
import { useOrg } from "../../lib/useOrg";
import type { Release, Runtime } from "../../lib/types";
import { useProject } from "../projects/ProjectContext";

const STATE = {
  queued: "En attente",
  building: "Construction",
  ready: "Prêt",
  failed: "Échec",
  stopped: "Expiré",
};
export function ReleasesPage() {
  const { project: p } = useProject(),
    { orgId, isAdmin } = useOrg();
  const runtime = useQuery({ ...runtimeQuery(orgId, p.id), enabled: isAdmin });
  return (
    <div className="grid gap-8">
      <Section
        title="Publications"
        hint="Construis un aperçu, vérifie le résultat et publie cette version sur ton serveur Docker."
      >
        <PreviewPanel projectId={p.id} />
      </Section>
      {isAdmin && (
        <Section
          title="Exécution et publication"
          hint="L'agent ne reçoit jamais les secrets de production."
        >
          {runtime.isPending ? (
            <Skeleton className="h-40" />
          ) : runtime.error ? (
            <ErrorBox error={runtime.error} />
          ) : (
            <>
              {!runtime.data.appsDomain && (
                <p className="mb-4 rounded-lg bg-warn-soft p-4 text-sm text-warn">
                  Configure le domaine des applications et son proxy Docker sur
                  le serveur avant le premier aperçu. Voir la documentation de
                  déploiement.
                </p>
              )}
              <RuntimeForm
                key={JSON.stringify(runtime.data.runtime)}
                projectId={p.id}
                initial={runtime.data.runtime}
              />
              <EnvironmentForm projectId={p.id} />
            </>
          )}
        </Section>
      )}
    </div>
  );
}
export function PreviewPanel({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId?: string;
}) {
  const { orgId, isAdmin, isMember } = useOrg(),
    q = useQuery(releasesQuery(orgId, projectId));
  const [selected, setSelected] = useState<string | null>(null),
    [mobile, setMobile] = useState(false),
    [reviewed, setReviewed] = useState(false),
    [logsOpen, setLogsOpen] = useState(false);
  const versions = q.data?.filter((r) => !taskId || r.task_id === taskId) ?? [],
    current = versions.find((r) => r.id === selected) ?? versions[0];
  const access = useQuery({
    queryKey: ["org", orgId, "preview-access", current?.id],
    enabled: current?.state === "ready" && !!current.url,
    staleTime: 20 * 60_000,
    retry: false,
    queryFn: async () => {
      const { ticket } = await api.post<{ ticket: string }>(
        `/api/orgs/${orgId}/releases/${current!.id}/access`,
      );
      const response = await fetch(`${current!.url}/.atelier/access`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket }),
      });
      if (!response.ok)
        throw new Error(
          "L'aperçu n'a pas pu être autorisé. Vérifie le domaine, HTTPS et les cookies du navigateur.",
        );
      return true;
    },
  });
  const build = useMutation({
    mutationFn: () =>
      api.post(
        `/api/orgs/${orgId}/projects/${projectId}/releases`,
        taskId ? { taskId } : {},
      ),
    onSuccess: () => invalidateOrg(orgId, "releases", projectId),
  });
  const publish = useMutation({
    mutationFn: ({ r, rollback }: { r: Release; rollback?: boolean }) =>
      api.post(
        `/api/orgs/${orgId}/releases/${r.id}/${rollback ? "rollback" : "publish"}`,
        { reviewed },
      ),
    onSuccess: () => invalidateOrg(orgId, "releases", projectId),
  });
  return (
    <Card className="flex min-w-0 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <Globe2 className="size-4 text-accent" />
          L'application
        </span>
        <div className="flex flex-wrap gap-2">
          {isMember && (
            <Button
              size="sm"
              icon={<Play className="size-3.5" />}
              onClick={() => build.mutate()}
              loading={build.isPending}
              disabled={versions.some(
                (r) => r.state === "building" || r.state === "queued",
              )}
            >
              Construire un aperçu
            </Button>
          )}
        </div>
      </div>
      <div className="px-4 pt-3">
        <FormError
          error={q.error ?? build.error ?? publish.error ?? access.error}
        />
      </div>
      {!current ? (
        <div className="p-5">
          <EmptyState
            title="Ton résultat apparaîtra ici"
            hint="L'aperçu se construit côté serveur. Tu peux fermer cette page pendant le travail."
          />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Badge
              tone={
                current.published
                  ? "ok"
                  : current.state === "failed"
                    ? "bad"
                    : current.state === "ready"
                      ? "info"
                      : "muted"
              }
            >
              {current.published ? "En production" : STATE[current.state]}
            </Badge>
            <span className="text-sm font-medium">
              Version {current.number}
            </span>
            <Button size="sm" onClick={()=>setLogsOpen(true)}>Voir les logs</Button>
            {current.state === "ready" && (
              <button
                type="button"
                onClick={() => setMobile(!mobile)}
                className="ml-auto text-xs text-muted hover:text-ink"
              >
                {mobile ? "Vue bureau" : "Vue mobile"}
              </button>
            )}
          </div>
          <div className="grid gap-1 px-4 pb-3 text-xs text-muted">
            <p className="break-words">{current.taskPrompt ?? "Construction depuis la branche du projet"}</p>
            <p className="break-all">Branche : <code>{current.ref}</code>{current.sha && <> · Commit : <code>{current.sha.slice(0,8)}</code></>}</p>
            {current.task_id && <Link to="/o/$orgId/tasks/$taskId" params={{orgId,taskId:current.task_id}} className="text-accent hover:underline">Voir la tâche à l’origine de cette version</Link>}
            {current.state==="failed" && <p className="text-warn">Cette construction a échoué. La version déjà en production reste en ligne. Ouvre les logs pour voir l’étape et la commande concernées.</p>}
          </div>
          <Dialog open={logsOpen} onClose={()=>setLogsOpen(false)} title={`Logs · Version ${current.number}`} wide>
            <ReleaseLogs release={current}/>
          </Dialog>
          {current.state === "ready" && current.url ? (
            <div className="flex min-h-[32rem] flex-1 justify-center bg-subtle p-2">
              <iframe
                key={current.id}
                title="Aperçu de l'application"
                src={access.isSuccess ? current.url : undefined}
                sandbox="allow-scripts allow-forms allow-same-origin allow-downloads"
                referrerPolicy="no-referrer"
                className={`min-h-[32rem] rounded-md border border-line bg-white ${mobile ? "w-[390px] max-w-full" : "w-full"}`}
              />
            </div>
          ) : (
            <div className="grid min-h-64 place-items-center bg-subtle px-5 py-8">
              <p
                role="status"
                className="max-w-xl whitespace-pre-wrap text-sm text-muted"
              >
                {current.error ?? current.log ?? STATE[current.state]}
              </p>
            </div>
          )}
          <div className="grid gap-3 border-t border-line p-4">
            <div className="flex flex-wrap gap-3 text-xs text-muted">
              <span>
                Vérification : {current.check_ok ? "réussie" : current.state==="failed"?"non validée":"en attente"}
              </span>
              <span>
                Navigateur : {current.qa_ok ? "réussi" : "en attente"}
              </span>
              {current.qa_ok > 0 && (
                <>
                  <a
                    href={`/api/orgs/${orgId}/releases/${current.id}/desktop.png`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent"
                  >
                    Capture bureau
                  </a>
                  <a
                    href={`/api/orgs/${orgId}/releases/${current.id}/mobile.png`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent"
                  >
                    Capture mobile
                  </a>
                </>
              )}
            </div>
            {isAdmin && current.state === "ready" && !current.published && (
              <div className="grid gap-3">
                <label className="flex items-start gap-2 text-xs text-muted">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    J'ai relu les éventuelles modifications de chemins protégés.
                  </span>
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <ConfirmButton
                    variant="primary"
                    size="sm"
                    icon={<Rocket className="size-3.5" />}
                    onConfirm={() => publish.mutate({ r: current })}
                    loading={publish.isPending}
                  >
                    Publier cette version
                  </ConfirmButton>
                  <p className="text-xs text-muted">
                    La version en ligne change après un démarrage réussi.
                  </p>
                </div>
              </div>
            )}
            {current.published && current.productionUrl && (
              <a
                href={current.productionUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm font-medium text-accent"
              >
                Voir le site en ligne
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>
        </>
      )}
      {versions.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <p className="label mb-2">Historique des versions</p>
          <ul className="grid max-h-60 gap-1 overflow-auto">
            {versions.map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 hover:bg-line/40"
              >
                <button
                  type="button"
                  className={`flex min-w-0 flex-1 items-center gap-3 text-left text-xs ${current?.id === r.id ? "font-medium text-ink" : "text-muted"}`}
                  onClick={() => {
                    setSelected(r.id);
                    setReviewed(false);
                  }}
                >
                  <span className="shrink-0">Version {r.number}</span>
                  <span className="truncate" title={r.taskPrompt??r.ref}>{r.taskPrompt??r.ref}</span>
                  <span>{fmtDate(r.created_at)}</span>
                  <span>{r.published ? "En ligne" : STATE[r.state]}</span>
                </button>
                {isAdmin &&
                  !!r.published_at &&
                  !r.published &&
                  r.state === "ready" && (
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      icon={<RotateCcw className="size-3" />}
                      onConfirm={() => publish.mutate({ r, rollback: true })}
                      loading={publish.isPending}
                    >
                      Restaurer
                    </ConfirmButton>
                  )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
function ReleaseLogs({release}:{release:Release}) {
  const {orgId}=useOrg();
  const q=useQuery({queryKey:["org",orgId,"release-log",release.id],queryFn:()=>api.get<Release>(`/api/orgs/${orgId}/releases/${release.id}`),refetchInterval:release.state==="building"||release.state==="queued"?2000:false});
  return <div className="grid gap-3">
    <a href={`/api/orgs/${orgId}/releases/${release.id}/logs`} download className="text-sm font-medium text-accent hover:underline">Télécharger le journal complet (.log)</a>
    <FormError error={q.error}/>
    <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-subtle p-4 font-mono text-xs">{q.data?.log||release.log||"Aucun log pour le moment."}</pre>
    <p className="text-xs text-muted">Journal de construction horodaté, limité à 120 000 caractères. Les secrets détectés sont masqués.</p>
  </div>;
}
function RuntimeForm({
  projectId,
  initial,
}: {
  projectId: string;
  initial: Runtime | null;
}) {
  const { orgId } = useOrg();
  const [build, setBuild] = useState(initial?.build ?? "npm run build"),
    [output, setOutput] = useState(initial?.output ?? "dist"),
    [start, setStart] = useState(initial?.start ?? "");
  const [policy, setPolicy] = useState<Runtime["policy"]>(
      initial?.policy ?? "manual",
    ),
    [preview, setPreview] = useState(initial?.preview ?? true);
  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/orgs/${orgId}/projects/${projectId}/runtime`, {
        build,
        output,
        start,
        policy,
        preview,
      }),
    onSuccess: () => {
      invalidateOrg(orgId, "runtime", projectId);
      invalidateOrg(orgId, "projects");
    },
  });
  return (
    <Card className="p-5">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="grid gap-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Commande de build"
            hint="Vide pour un site HTML ou un serveur sans compilation."
          >
            {(id) => (
              <Input
                id={id}
                value={build}
                onChange={(e) => setBuild(e.target.value)}
                maxLength={500}
                className="font-mono text-sm"
              />
            )}
          </Field>
          <Field
            label="Dossier du site compilé"
            hint="Pour un site statique : dist ou public."
          >
            {(id) => (
              <Input
                id={id}
                value={output}
                onChange={(e) => setOutput(e.target.value)}
                required
                className="font-mono text-sm"
              />
            )}
          </Field>
        </div>
        <Field
          label="Commande du serveur"
          hint="Vide : sert le site statique. Node.js : npm start, sur 0.0.0.0 et le port 3000."
        >
          {(id) => (
            <Input
              id={id}
              value={start}
              onChange={(e) => setStart(e.target.value)}
              maxLength={500}
              placeholder="npm start"
              className="font-mono text-sm"
            />
          )}
        </Field>
        <Field label="Publication">
          {(id) => (
            <Select
              id={id}
              value={policy}
              onChange={(e) => setPolicy(e.target.value as Runtime["policy"])}
            >
              <option value="manual">
                Manuelle : je choisis quand publier
              </option>
              <option value="approved">
                Après validation : je valide la version à publier
              </option>
              <option value="automatic">
                Automatique : si tous les contrôles passent
              </option>
            </Select>
          )}
        </Field>
        {policy === "automatic" && (
          <p className="text-sm text-warn">
            Les chemins protégés exigent toujours une relecture. Les droits de
            la personne qui lance la tâche sont vérifiés avant publication.
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={preview}
            onChange={(e) => setPreview(e.target.checked)}
          />
          Construire un aperçu après chaque proposition
        </label>
        <FormError error={save.error} />
        <div className="flex items-center justify-end gap-3">
          {save.isSuccess && (
            <span className="text-sm text-ok" role="status">
              Configuration enregistrée.
            </span>
          )}
          <Button type="submit" loading={save.isPending}>
            Enregistrer l'exécution
          </Button>
        </div>
      </form>
    </Card>
  );
}
function EnvironmentForm({ projectId }: { projectId: string }) {
  const { orgId } = useOrg(),
    q = useQuery(environmentQuery(orgId, projectId));
  const [env, setEnv] = useState("preview"),
    [name, setName] = useState(""),
    [value, setValue] = useState("");
  const save = useMutation({
    mutationFn: (data: {
      environment: string;
      name: string;
      value: string | null;
    }) => api.put(`/api/orgs/${orgId}/projects/${projectId}/environment`, data),
    onSuccess: () => {
      setValue("");
      invalidateOrg(orgId, "environment", projectId);
    },
  });
  return (
    <Card className="mt-4 p-5">
      <h3 className="text-sm font-medium">Variables d'environnement</h3>
      <p className="mt-1 text-xs text-muted">
        Chiffrées, injectées au démarrage du serveur de l'application. Elles ne
        sont accessibles ni à l'agent ni au build du frontend.
      </p>
      <ul className="my-3 grid gap-2">
        {q.data?.map((v) => (
          <li
            key={`${v.environment}:${v.name}`}
            className="flex items-center justify-between text-xs"
          >
            <span>
              <Badge>{v.environment}</Badge>
              <code className="ml-2">{v.name}</code>
            </span>
            <ConfirmButton
              size="sm"
              variant="ghost"
              onConfirm={() => save.mutate({ ...v, value: null })}
            >
              Supprimer
            </ConfirmButton>
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({ environment: env, name, value });
        }}
        className="grid gap-3 sm:grid-cols-3"
      >
        <Field label="Environnement">
          {(id) => (
            <Select
              id={id}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
            >
              <option value="preview">Aperçu</option>
              <option value="production">Production</option>
            </Select>
          )}
        </Field>
        <Field label="Nom de variable">
          {(id) => (
            <Input
              id={id}
              value={name}
              onChange={(e) => setName(e.target.value)}
              pattern="[A-Z][A-Z0-9_]{0,79}"
              required
              placeholder="API_URL"
              className="font-mono text-sm"
            />
          )}
        </Field>
        <Field label="Valeur">
          {(id) => (
            <Input
              id={id}
              type="password"
              autoComplete="new-password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={10000}
            />
          )}
        </Field>
        <div className="sm:col-span-3">
          <FormError error={save.error ?? q.error} />
          <Button type="submit" size="sm" loading={save.isPending}>
            Enregistrer la variable
          </Button>
        </div>
      </form>
    </Card>
  );
}
