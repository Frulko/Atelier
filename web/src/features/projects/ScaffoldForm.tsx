import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input, Select, Textarea } from "../../components/ui/Field";
import { FormError } from "../../components/ui/Feedback";
import { api } from "../../lib/api";
import { invalidateOrg } from "../../lib/queries";
import { slugify } from "../../lib/slug";
import type { Project } from "../../lib/types";
import { useOrg } from "../../lib/useOrg";
export function ScaffoldForm({
  onDone,
  onCancel,
}: {
  onDone: (p: Project) => void;
  onCancel: () => void;
}) {
  const { orgId } = useOrg();
  const [name, setName] = useState(""),
    [slug, setSlug] = useState(""),
    [touched, setTouched] = useState(false),
    [template, setTemplate] = useState("react"),
    [prompt, setPrompt] = useState("");
  const save = useMutation({
    mutationFn: () =>
      api.post<{ project: Project }>(`/api/orgs/${orgId}/projects/scaffold`, {
        name,
        slug,
        template,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
      }),
    onSuccess: ({ project }) => {
      invalidateOrg(orgId);
      onDone(project);
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
      <Field label="Nom affiché">
        {(id) => (
          <Input
            id={id}
            value={name}
            required
            maxLength={80}
            onChange={(e) => {
              setName(e.target.value);
              if (!touched) setSlug(slugify(e.target.value));
            }}
            autoFocus
          />
        )}
      </Field>
      <Field label="Identifiant">
        {(id) => (
          <Input
            id={id}
            value={slug}
            required
            pattern="[a-z0-9][a-z0-9\-]{0,39}"
            onChange={(e) => {
              setTouched(true);
              setSlug(e.target.value);
            }}
          />
        )}
      </Field>
      <Field label="Point de départ">
        {(id) => (
          <Select
            id={id}
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="react">Application React</option>
            <option value="static">Site HTML / CSS</option>
            <option value="node">Application Node.js</option>
          </Select>
        )}
      </Field>
      <Field
        label="Décris ton projet"
        hint="L'agent démarre après la création. Tu peux quitter la page pendant son travail."
      >
        {(id) => (
          <Textarea
            id={id}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            maxLength={20000}
            placeholder="Un site pour mon atelier de céramique : catalogue, tarifs et formulaire de contact…"
          />
        )}
      </Field>
      <p className="text-xs text-muted">
        Atelier crée et conserve le dépôt sur ton serveur. Les aperçus et
        publications utilisent la cible Docker configurée.
      </p>
      <FormError error={save.error} />
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Annuler</Button>
        <Button variant="primary" type="submit" loading={save.isPending}>
          Créer mon projet
        </Button>
      </div>
    </form>
  );
}
