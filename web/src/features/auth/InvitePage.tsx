import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { FormError } from "../../components/ui/Feedback";
import { api, ApiError } from "../../lib/api";
import { meQuery, refreshMe } from "../../lib/queries";
import { rememberOrg } from "../../components/layout/OrgSwitcher";
import { AuthLayout } from "./AuthLayout";

const route = getRouteApi("/invite");

export function InvitePage() {
  const { token } = route.useSearch();
  const { data: me } = useQuery(meQuery);
  const router = useRouter();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const accept = useMutation({
    mutationFn: () => api.post<{ orgId: string }>("/api/auth/accept-invite", me ? { token } : { token, password }),
    onSuccess: async ({ orgId }) => {
      await refreshMe(qc);
      rememberOrg(orgId);
      router.history.push(`/o/${orgId}`);
    },
  });
  const needsLogin = accept.error instanceof ApiError && accept.error.status === 409;
  const back = `/invite?token=${encodeURIComponent(token ?? "")}`;

  if (!token) return <AuthLayout title="Lien incomplet" subtitle="Il manque le jeton d'invitation. Rouvre le lien complet que l'on t'a transmis."><Link to="/login" className="text-sm font-medium text-accent hover:underline">Aller à la connexion</Link></AuthLayout>;

  return (
    <AuthLayout title="Tu es invité(e)." subtitle={me ? <>Tu es connecté(e) en tant que <b className="text-ink">{me.user.email}</b>. L'invitation doit avoir été faite pour cette adresse.</> : "Choisis un mot de passe pour créer ton compte. L'adresse e-mail est celle de l'invitation."}>
      <form onSubmit={(e) => { e.preventDefault(); accept.mutate(); }} className="grid gap-4">
        {!me && <Field label="Mot de passe" hint="8 caractères minimum.">{(id) => <Input id={id} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} autoFocus />}</Field>}
        <FormError error={accept.error} />
        <Button variant="primary" type="submit" loading={accept.isPending} className="w-full">{me ? "Rejoindre l'organisation" : "Créer mon compte et rejoindre"}</Button>
      </form>
      {(needsLogin || !me) && <p className="mt-6 text-sm text-muted">Tu as déjà un compte ? <Link to="/login" search={{ redirect: back }} className="font-medium text-accent hover:underline">Connecte-toi d'abord</Link>, l'invitation te sera proposée ensuite.</p>}
    </AuthLayout>
  );
}
