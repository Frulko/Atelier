import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, Copy, MailPlus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Avatar } from "../../components/ui/Avatar";
import { RoleBadge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Card, PageHeader, Section } from "../../components/ui/Card";
import { ConfirmButton } from "../../components/ui/ConfirmButton";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, ErrorBox, FormError, Skeleton } from "../../components/ui/Feedback";
import { Field, Input, Select } from "../../components/ui/Field";
import { useToast } from "../../components/ui/Toast";
import { api } from "../../lib/api";
import { relTime } from "../../lib/format";
import { invalidateOrg, invitationsQuery, meQuery, membersQuery, queryClient } from "../../lib/queries";
import { canAssign, canTouch, ROLE_HELP, ROLE_LABEL, ROLES } from "../../lib/roles";
import { useOrg } from "../../lib/useOrg";
import type { NewInvitation, Role } from "../../lib/types";

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { orgId, role } = useOrg();
  const [email, setEmail] = useState("");
  const [r, setR] = useState<Role>("member");
  const [made, setMade] = useState<NewInvitation | null>(null);
  const [copied, setCopied] = useState(false);
  const invite = useMutation({
    mutationFn: () => api.post<NewInvitation>(`/api/orgs/${orgId}/invitations`, { email, role: r }),
    onSuccess: (inv) => { setMade(inv); invalidateOrg(orgId, "invitations"); },
  });
  const link = made ? `${location.origin}/invite?token=${encodeURIComponent(made.token)}` : "";
  const close = () => { setMade(null); setEmail(""); setCopied(false); invite.reset(); onClose(); };
  const copy = async () => { try { await navigator.clipboard.writeText(link); setCopied(true); } catch { /* le champ reste sélectionnable à la main */ } };

  return (
    <Dialog open={open} onClose={close} title={made ? "Lien d'invitation" : "Inviter quelqu'un"} description={made ? undefined : "Aucun e-mail n'est envoyé : tu reçois un lien à transmettre toi-même."}>
      {made ? (
        <div className="grid gap-4">
          <p className="text-sm text-muted">Lien pour <b className="text-ink">{made.email}</b> comme <b className="text-ink">{ROLE_LABEL[made.role].toLowerCase()}</b>. Il n'est montré <b className="text-ink">qu'une seule fois</b> et expire dans 7 jours.</p>
          <div className="flex gap-2"><Input readOnly value={link} aria-label="Lien d'invitation" onFocus={(e) => e.currentTarget.select()} className="font-mono text-xs" /><Button icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />} onClick={copy}>{copied ? "Copié" : "Copier"}</Button></div>
          <div className="flex justify-end"><Button variant="primary" onClick={close}>Terminé</Button></div>
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); invite.mutate(); }} className="grid gap-4">
          <Field label="Adresse e-mail">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />}</Field>
          <Field label="Rôle" hint={ROLE_HELP[r]}>
            {(id) => <Select id={id} value={r} onChange={(e) => setR(e.target.value as Role)}>{ROLES.filter((x) => role && canAssign(role, x)).map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</Select>}
          </Field>
          <FormError error={invite.error} />
          <div className="flex justify-end gap-2"><Button onClick={close}>Annuler</Button><Button variant="primary" type="submit" loading={invite.isPending}>Créer le lien</Button></div>
        </form>
      )}
    </Dialog>
  );
}

export function TeamPage() {
  const { orgId, role, me } = useOrg();
  const members = useQuery(membersQuery(orgId));
  const invitations = useQuery(invitationsQuery(orgId));
  const [inviting, setInviting] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const fail = (e: unknown) => toast(e instanceof Error ? e.message : "Échec", "bad");

  const setRole = useMutation({
    mutationFn: (v: { userId: string; role: Role }) => api.patch(`/api/orgs/${orgId}/members/${v.userId}`, { role: v.role }),
    onSuccess: (_d, v) => { invalidateOrg(orgId, "members"); invalidateOrg(orgId, "audit"); if (v.userId === me?.user.id) queryClient.invalidateQueries({ queryKey: meQuery.queryKey }); toast("Rôle mis à jour."); },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api.del(`/api/orgs/${orgId}/members/${userId}`),
    onSuccess: async (_d, userId) => {
      invalidateOrg(orgId, "members"); invalidateOrg(orgId, "audit"); toast("Membre retiré.");
      if (userId === me?.user.id) { await queryClient.invalidateQueries({ queryKey: meQuery.queryKey }); navigate({ to: "/" }); }
    },
    onError: fail,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/orgs/${orgId}/invitations/${id}`), onSuccess: () => { invalidateOrg(orgId, "invitations"); toast("Invitation révoquée."); }, onError: fail });

  return (
    <>
      <PageHeader title="Équipe" subtitle="Qui a accès à cette organisation, avec quel rôle, et les invitations en attente."
        actions={<Button variant="primary" icon={<MailPlus className="size-4" />} onClick={() => setInviting(true)}>Inviter</Button>} />

      <ul className="mb-10 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[...ROLES].reverse().map((r, i) => (
          <li key={r} className="rise rounded-2xl border border-line bg-surface p-4" style={{ ["--i" as string]: i }}>
            <div className="mb-2 flex items-center gap-2"><ShieldCheck className="size-4 text-muted" aria-hidden /><RoleBadge role={r} /></div>
            <p className="text-[13px] leading-snug text-muted">{ROLE_HELP[r]}</p>
          </li>
        ))}
      </ul>

      <Section title="Membres" hint={members.data ? `${members.data.length} personne${members.data.length > 1 ? "s" : ""}` : undefined} className="mb-10" index={4}>
        {members.isError && <ErrorBox error={members.error} retry={() => members.refetch()} />}
        {members.isLoading ? <Skeleton className="h-48" /> : (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm">
              <thead><tr className="border-b border-line">{["Membre", "Rôle", ""].map((h, i) => <th key={i} className="label px-4 py-3 font-normal">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {members.data?.map((m) => {
                  const mine = m.userId === me?.user.id, can = !!role && canTouch(role, m.role);
                  return (
                    <tr key={m.userId}>
                      <td className="px-4 py-3"><span className="flex items-center gap-3"><Avatar name={m.email} /><span className="min-w-0"><span className="block truncate text-[15px] text-ink">{m.email}</span>{mine && <span className="text-xs text-muted">toi</span>}</span></span></td>
                      <td className="px-4 py-3">
                        {can ? <Select aria-label={`Rôle de ${m.email}`} value={m.role} className="h-9 w-44" onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value as Role })}>
                          {ROLES.filter((r) => r === m.role || (role && canAssign(role, r))).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select> : <RoleBadge role={m.role} />}
                      </td>
                      <td className="px-4 py-3 text-right"><ConfirmButton size="sm" disabled={!can} onConfirm={() => remove.mutate(m.userId)} confirmLabel={mine ? "Quitter ?" : "Retirer ?"}>{mine ? "Quitter" : "Retirer"}</ConfirmButton></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
      </Section>

      <Section title="Invitations en attente" hint="Les liens expirent au bout de 7 jours et ne servent qu'une fois." index={5}>
        {invitations.isLoading ? <Skeleton className="h-24" /> : invitations.data && invitations.data.length ? (
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-left text-sm"><tbody className="divide-y divide-line">
              {invitations.data.map((i) => (
                <tr key={i.id}>
                  <td className="px-4 py-3 text-[15px]">{i.email}</td><td className="px-4 py-3"><RoleBadge role={i.role} /></td>
                  <td className="px-4 py-3 text-[13px] text-muted">expire {relTime(i.expires_at)}</td>
                  <td className="px-4 py-3 text-right"><Button size="sm" onClick={() => revoke.mutate(i.id)} loading={revoke.isPending && revoke.variables === i.id}>Révoquer</Button></td>
                </tr>
              ))}
            </tbody></table>
          </Card>
        ) : <EmptyState title="Aucune invitation en attente" hint="Invite un collègue : tu obtiendras un lien à lui transmettre." action={<Button onClick={() => setInviting(true)}>Inviter</Button>} />}
      </Section>
      <InviteDialog open={inviting} onClose={() => setInviting(false)} />
    </>
  );
}
