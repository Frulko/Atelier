import { useMutation, useQuery } from "@tanstack/react-query";
import { Laptop, Monitor, Moon, Smartphone, Sun } from "lucide-react";
import { useState } from "react";
import { Avatar } from "../../components/ui/Avatar";
import { Badge, RoleBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader, Section } from "../../components/ui/Card";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { FormError, Skeleton } from "../../components/ui/Feedback";
import { Field, Input } from "../../components/ui/Field";
import { Tabs } from "../../components/ui/Tabs";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { fmtDateTime, relTime } from "../../lib/format";
import { describeOwn } from "../../lib/labels";
import { activityQuery, meQuery, queryClient, sessionsQuery } from "../../lib/queries";
import { setTheme, useTheme, type Theme } from "../../lib/theme";
import { describeAgent } from "../../lib/ua";
import { useOrg } from "../../lib/useOrg";

function Profile() {
  const { me } = useOrg();
  const toast = useToast();
  const [name, setName] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api.patch("/api/me", { name: (name ?? "").trim() || null }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: meQuery.queryKey }); setName(null); toast("Profil enregistré."); },
  });
  return (
    <Card className="p-6">
      <form onSubmit={(e) => { e.preventDefault(); save.mutate(); }} className="grid gap-4 sm:max-w-md">
        <div className="flex items-center gap-4"><Avatar name={me?.user.name ?? me?.user.email} size={56} /><div className="min-w-0"><p className="truncate font-display text-xl">{me?.user.name ?? me?.user.email.split("@")[0]}</p><p className="truncate text-sm text-muted">{me?.user.email}</p></div></div>
        <Field label="Nom affiché" hint="Visible par ton équipe à la place de l'adresse e-mail.">{(id) => <Input id={id} value={name ?? me?.user.name ?? ""} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Marie Curie" />}</Field>
        <FormError error={save.error} />
        <div><Button variant="primary" type="submit" loading={save.isPending} disabled={name === null}>Enregistrer</Button></div>
      </form>
    </Card>
  );
}

function Password() {
  const toast = useToast();
  const [cur, setCur] = useState(""), [next, setNext] = useState(""), [again, setAgain] = useState("");
  const mismatch = again !== "" && next !== again;
  const change = useMutation({
    mutationFn: () => api.post("/api/auth/password", { current: cur, next }),
    onSuccess: () => { setCur(""); setNext(""); setAgain(""); queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey }); toast("Mot de passe changé. Les autres appareils sont déconnectés."); },
  });
  return (
    <Card className="p-6">
      <form onSubmit={(e) => { e.preventDefault(); if (!mismatch) change.mutate(); }} className="grid gap-4 sm:max-w-md">
        <Field label="Mot de passe actuel">{(id) => <Input id={id} type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />}</Field>
        <Field label="Nouveau mot de passe" hint="8 caractères minimum. Les autres appareils seront déconnectés.">{(id) => <Input id={id} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} />}</Field>
        <Field label="Confirmer le nouveau mot de passe" error={mismatch ? "Les deux saisies sont différentes." : null}>{(id) => <Input id={id} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />}</Field>
        <FormError error={change.error} />
        <div><Button variant="primary" type="submit" loading={change.isPending} disabled={mismatch}>Changer le mot de passe</Button></div>
      </form>
    </Card>
  );
}

function Sessions() {
  const toast = useToast();
  const q = useQuery(sessionsQuery);
  const done = () => queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/me/sessions/${id}`), onSuccess: () => { done(); toast("Session révoquée."); }, onError: (e) => toast(e instanceof Error ? e.message : "Échec", "bad") });
  const others = useMutation({ mutationFn: () => api.post("/api/me/sessions/revoke-others"), onSuccess: () => { done(); toast("Les autres appareils sont déconnectés."); } });
  const list = q.data ?? [];
  return (
    <Card className="overflow-hidden">
      {q.isLoading ? <Skeleton className="m-4 h-24" /> : (
        <>
          <ul className="divide-y divide-line">
            {list.map((s) => {
              const phone = /iOS|Android/.test(describeAgent(s.userAgent)), Icon = phone ? Smartphone : /curl|inconnu/i.test(describeAgent(s.userAgent)) ? Monitor : Laptop;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                  <span className="grid size-10 place-items-center rounded-full bg-line/70 text-muted"><Icon className="size-[18px]" aria-hidden /></span>
                  <div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-[15px] text-ink">{describeAgent(s.userAgent)}{s.current && <Badge tone="ok">Cet appareil</Badge>}</p><p className="mt-0.5 text-xs text-muted"><span className="font-mono">{s.ip ?? "—"}</span> · actif {relTime(s.lastUsedAt)} · ouvert le {fmtDateTime(s.createdAt)}</p></div>
                  {!s.current && <ConfirmButton size="sm" onConfirm={() => revoke.mutate(s.id)}>Révoquer</ConfirmButton>}
                </li>
              );
            })}
          </ul>
          {list.length > 1 && <div className="border-t border-line bg-line/30 px-5 py-3"><ConfirmButton size="sm" variant="secondary" onConfirm={() => others.mutate()} loading={others.isPending} confirmLabel="Déconnecter tous les autres ?">Déconnecter tous les autres appareils</ConfirmButton></div>}
        </>
      )}
    </Card>
  );
}

function Appearance() {
  const theme = useTheme();
  const items: { value: Theme; label: string }[] = [{ value: "system", label: "Système" }, { value: "light", label: "Clair" }, { value: "dark", label: "Sombre" }];
  return (
    <Card className="flex flex-wrap items-center justify-between gap-4 p-6">
      <p className="flex items-center gap-2 text-[15px]">{theme === "dark" ? <Moon className="size-4 text-muted" aria-hidden /> : <Sun className="size-4 text-muted" aria-hidden />}Thème de l'interface</p>
      <Tabs label="Thème" value={theme} onChange={(v) => setTheme(v)} items={items} />
    </Card>
  );
}

function Activity() {
  const q = useQuery(activityQuery);
  return (
    <Card className="overflow-hidden">
      {q.isLoading ? <Skeleton className="m-4 h-32" /> : q.data && q.data.length ? (
        <ol className="divide-y divide-line">
          {q.data.slice(0, 15).map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-3 text-sm">
              <span className="text-ink">{describeOwn(a)}{a.orgName && <span className="text-muted"> · {a.orgName}</span>}</span>
              <span className="whitespace-nowrap text-xs text-muted" title={fmtDateTime(a.ts)}>{relTime(a.ts)}{a.ip ? ` · ${a.ip}` : ""}</span>
            </li>
          ))}
        </ol>
      ) : <p className="px-5 py-8 text-center text-sm text-muted">Aucune activité pour l'instant.</p>}
    </Card>
  );
}

export function AccountPage() {
  const { me } = useOrg();
  return (
    <>
      <PageHeader title="Mon compte" subtitle="Ton profil, ta sécurité et tes appareils connectés." />
      <div className="grid max-w-3xl gap-10">
        <Section title="Profil" index={1}><Profile /></Section>
        <Section title="Organisations" index={2}>
          <Card className="divide-y divide-line">{me?.orgs.map((o) => <div key={o.id} className="flex items-center justify-between gap-3 px-5 py-3.5"><span className="text-[15px]">{o.name}</span><RoleBadge role={o.role} /></div>)}</Card>
        </Section>
        <Section title="Mot de passe" index={3}><Password /></Section>
        <Section title="Appareils connectés" hint="Révoque une session si tu ne reconnais pas l'appareil." index={4}><Sessions /></Section>
        <Section title="Apparence" index={5}><Appearance /></Section>
        <Section title="Activité récente" hint="Ce que tu as fait, dans toutes tes organisations." index={6}><Activity /></Section>
      </div>
    </>
  );
}
