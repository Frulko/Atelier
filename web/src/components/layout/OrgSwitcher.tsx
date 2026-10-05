import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { refreshMe } from "../../lib/queries";
import { ROLE_LABEL } from "../../lib/roles";
import { useOrg } from "../../lib/useOrg";
import type { OrgRef } from "../../lib/types";
import { Button } from "../ui/Button";
import { Dialog } from "../ui/Dialog";
import { Field, Input } from "../ui/Field";
import { FormError } from "../ui/Feedback";

export const rememberOrg = (id: string) => { try { localStorage.setItem("atelier-org", id); } catch { /* stockage indisponible */ } };
export const lastOrg = () => { try { return localStorage.getItem("atelier-org"); } catch { return null; } };

export function OrgSwitcher() {
  const { org, me } = useOrg();
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", off); document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", off); document.removeEventListener("keydown", esc); };
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.post<OrgRef>("/api/orgs", { name }),
    onSuccess: async (o) => {
      await refreshMe(qc);
      rememberOrg(o.id); setCreating(false); setName("");
      navigate({ to: "/o/$orgId", params: { orgId: o.id } });
    },
  });

  const go = (id: string) => { rememberOrg(id); setOpen(false); navigate({ to: "/o/$orgId", params: { orgId: id } }); };

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-expanded={open}
        className="flex w-full items-center gap-3 rounded-lg border border-side-line bg-raised px-3 py-2 text-left shadow-xs transition-colors hover:bg-side-hover">
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-sm font-semibold text-primary-ink">{(org?.name ?? "?")[0]?.toUpperCase()}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-side-ink">{org?.name ?? "Organisation"}</span>
          <span className="block text-xs text-side-muted">{org ? ROLE_LABEL[org.role] : ""}</span>
        </span>
        <ChevronsUpDown className="size-4 shrink-0 text-side-muted" aria-hidden />
      </button>
      {open && (
        <div role="listbox" className="absolute left-0 right-0 top-full z-30 mt-2 overflow-hidden rounded-xl border border-line-strong bg-surface p-1.5 shadow-pop">
          {me?.orgs.map((o) => (
            <button key={o.id} role="option" aria-selected={o.id === org?.id} type="button" onClick={() => go(o.id)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-ink hover:bg-line/60">
              <span className="min-w-0 flex-1 truncate">{o.name}<span className="ml-2 text-xs text-muted">{ROLE_LABEL[o.role]}</span></span>
              {o.id === org?.id && <Check className="size-4 text-accent" aria-hidden />}
            </button>
          ))}
          <button type="button" onClick={() => { setOpen(false); setCreating(true); }} className="mt-1 flex w-full items-center gap-2 rounded-lg border-t border-line px-2.5 py-2 pt-3 text-left text-sm text-muted hover:text-ink">
            <Plus className="size-4" aria-hidden /> Nouvelle organisation
          </button>
        </div>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} title="Nouvelle organisation" description="Tu en seras le propriétaire. Tu pourras ensuite y inviter ton équipe.">
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }} className="grid gap-4">
          <Field label="Nom de l'organisation">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />}</Field>
          <FormError error={create.error} />
          <div className="flex justify-end gap-2"><Button onClick={() => setCreating(false)}>Annuler</Button><Button variant="primary" type="submit" loading={create.isPending}>Créer</Button></div>
        </form>
      </Dialog>
    </div>
  );
}
