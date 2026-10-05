import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select, Textarea } from "../../components/ui/Field";
import { FormError } from "../../components/ui/Feedback";
import { api } from "../../lib/api";
import { FORGE_LABEL } from "../../lib/labels";
import { invalidateOrg, secretsQuery } from "../../lib/queries";
import { slugify } from "../../lib/slug";
import { useOrg } from "../../lib/useOrg";
import type { Project } from "../../lib/types";

/** Création et modification d'un projet : le même formulaire, les mêmes règles que le serveur (qui reste seul juge). */
export function ProjectForm({ project, onDone, onCancel }: { project?: Project; onDone: (p: Project) => void; onCancel: () => void }) {
  const { orgId } = useOrg();
  const secrets = useQuery(secretsQuery(orgId));
  const gitSecrets = secrets.data?.filter((s) => s.kind === "git_token") ?? [];
  const [name, setName] = useState(project?.name ?? "");
  const [slug, setSlug] = useState(project?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!project);
  const [repo, setRepo] = useState(project?.repo ?? "");
  const [branch, setBranch] = useState(project?.branch ?? "main");
  const [forge, setForge] = useState<string>(project?.forge ?? "");
  const [check, setCheck] = useState(project?.check ?? "");
  const [paths, setPaths] = useState((project?.protectedPaths ?? []).join("\n"));
  const [secret, setSecret] = useState(project?.gitSecretId ?? "");

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name, slug, repo, branch: branch || "main", check: check || "true", ...(forge ? { forge } : {}),
        protectedPaths: paths.split(/[\n,]/).map((s) => s.trim()).filter(Boolean), gitSecretId: secret || null,
      };
      return project ? api.patch<Project>(`/api/orgs/${orgId}/projects/${project.id}`, body) : api.post<Project>(`/api/orgs/${orgId}/projects`, body);
    },
    onSuccess: (p) => { invalidateOrg(orgId, "projects"); invalidateOrg(orgId, "secrets"); onDone(p); },
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nom affiché">{(id) => <Input id={id} value={name} maxLength={80} required autoFocus onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} />}</Field>
        <Field label="Identifiant" hint="Minuscules, chiffres et tirets.">{(id) => <Input id={id} value={slug} required pattern="[a-z0-9][a-z0-9\-]{0,39}" onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} className="font-mono text-[13px]" />}</Field>
      </div>
      <Field label="Dépôt git" hint="URL https, sans identifiants : le jeton se règle plus bas.">{(id) => <Input id={id} type="url" value={repo} required placeholder="https://gitlab.exemple.fr/equipe/projet.git" onChange={(e) => setRepo(e.target.value)} className="font-mono text-[13px]" />}</Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Branche de base">{(id) => <Input id={id} value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className="font-mono text-[13px]" />}</Field>
        <Field label="Forge" hint="Laisse « Automatique » pour la déduire de l'URL.">
          {(id) => <Select id={id} value={forge} onChange={(e) => setForge(e.target.value)}><option value="">Automatique</option>{Object.entries(FORGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>}
        </Field>
      </div>
      <Field label="Commande de vérification" hint="Lancée sans réseau dans le bac à sable pour valider une modification. Vide : aucune vérification.">
        {(id) => <Input id={id} value={check} onChange={(e) => setCheck(e.target.value)} placeholder="node --check app.js" className="font-mono text-[13px]" />}
      </Field>
      <Field label="Chemins protégés" hint="Un par ligne. Si une modification en touche un, la relecture humaine est obligatoire.">
        {(id) => <Textarea id={id} rows={3} value={paths} onChange={(e) => setPaths(e.target.value)} placeholder={"db/\n.gitlab-ci.yml"} className="min-h-0 font-mono text-[13px]" />}
      </Field>
      <Field label="Jeton git" hint={<>Utilisé pour cloner, pousser et ouvrir la demande de fusion. <Link to="/o/$orgId/integrations" params={{ orgId }} className="font-medium text-accent hover:underline">Gérer les secrets</Link></>}>
        {(id) => <Select id={id} value={secret} onChange={(e) => setSecret(e.target.value)}><option value="">Aucun (dépôt public ou local)</option>{gitSecrets.map((s) => <option key={s.id} value={s.id}>{s.label} {s.hint}</option>)}</Select>}
      </Field>
      <FormError error={save.error} />
      <div className="flex justify-end gap-2"><Button onClick={onCancel}>Annuler</Button><Button variant="primary" type="submit" loading={save.isPending}>{project ? "Enregistrer" : "Créer le projet"}</Button></div>
    </form>
  );
}
