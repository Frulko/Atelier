import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { rememberOrg } from "../../components/layout/OrgSwitcher";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { FormError } from "../../components/ui/Feedback";
import { api } from "../../lib/api";
import { refreshMe } from "../../lib/queries";
import type { OrgRef } from "../../lib/types";

export function CreateOrgForm() {
  const [name, setName] = useState("");
  const qc = useQueryClient();
  const router = useRouter();
  const create = useMutation({
    mutationFn: () => api.post<OrgRef>("/api/orgs", { name }),
    onSuccess: async (o) => { await refreshMe(qc); rememberOrg(o.id); router.history.push(`/o/${o.id}`); },
  });
  return (
    <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="grid gap-4">
      <Field label="Nom de l'organisation">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />}</Field>
      <FormError error={create.error} />
      <Button variant="primary" type="submit" loading={create.isPending}>Créer l'organisation</Button>
    </form>
  );
}
