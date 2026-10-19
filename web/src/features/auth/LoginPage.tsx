import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../components/ui/Button";
import { Field, Input } from "../../components/ui/Field";
import { FormError } from "../../components/ui/Feedback";
import { api } from "../../lib/api";
import { refreshMe } from "../../lib/queries";
import { AuthLayout } from "./AuthLayout";

const route = getRouteApi("/login");

export function LoginPage() {
  const { redirect, sso } = route.useSearch();
  const ssoConfig=useQuery({queryKey:["auth","sso"],queryFn:()=>api.get<{enabled:boolean;label:string}>("/api/auth/sso")});
  const router = useRouter();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = useMutation({
    mutationFn: () => api.post("/api/auth/login", { email, password }),
    onSuccess: async () => {
      await refreshMe(qc);
      router.history.push(redirect ?? "/");
    },
  });
  return (
    <AuthLayout title="Content de te revoir." subtitle="Connecte-toi pour retrouver tes projets et tes tâches.">
      <form onSubmit={(e) => { e.preventDefault(); login.mutate(); }} className="grid gap-4">
        <Field label="Adresse e-mail">{(id) => <Input id={id} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}</Field>
        <Field label="Mot de passe">{(id) => <Input id={id} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />}</Field>
        <FormError error={login.error} />
        <Button variant="primary" type="submit" loading={login.isPending} className="mt-1 w-full">Se connecter</Button>
      </form>
      {sso && <p role="alert" className="mt-4 text-sm text-warn">{sso==="link_required"?"Connecte-toi avec ton mot de passe, puis associe Keycloak depuis ton compte. Une adresse e-mail identique ne suffit pas à créer un accès.":"La connexion Keycloak n'a pas abouti. Réessaie ou utilise ton mot de passe."}</p>}
      {ssoConfig.data?.enabled && <a href={`/api/auth/sso/start${redirect?`?returnTo=${encodeURIComponent(redirect)}`:""}`} className="mt-4 block"><Button className="w-full">Se connecter avec Keycloak</Button></a>}
      <p className="mt-6 text-sm text-muted">Pas de compte ? L'accès se fait sur invitation : demande un lien à un administrateur de ton organisation.</p>
    </AuthLayout>
  );
}
