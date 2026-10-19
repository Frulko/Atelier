import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bell, BellRing, CheckCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState, FormError } from "../../components/ui/Feedback";
import { api } from "../../lib/api";
import { notificationsQuery } from "../../lib/queries";
import { fmtDateTime as fmtDate } from "../../lib/format";
import { enablePush, disablePush, pushSupported } from "./push";

export function Notifications() {
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(false);
  useEffect(() => {
    if (pushSupported())
      void navigator.serviceWorker
        .getRegistration("/")
        .then((r) => r?.pushManager.getSubscription())
        .then((s) => setActive(!!s))
        .catch(() => {});
  }, []);
  const q = useQuery(notificationsQuery),
    qc = useQueryClient();
  const unread = q.data?.filter((n) => !n.readAt).length ?? 0;
  const mark = useMutation({
    mutationFn: (id?: number) =>
      api.post("/api/me/notifications/read", id ? { id } : {}),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: notificationsQuery.queryKey }),
  });
  const push = useMutation({
    mutationFn: async () => {
      if (active) await disablePush();
      else await enablePush();
      setActive(!active);
    },
  });
  return (
    <div className="ml-auto">
      <button
        type="button"
        className="relative rounded-md p-2 text-muted hover:bg-line hover:text-ink"
        aria-label={`Notifications${unread ? ` (${unread} non lues)` : ""}`}
        onClick={() => setOpen(true)}
      >
        <Bell className="size-5" aria-hidden />
        {unread > 0 && (
          <span className="absolute right-1 top-1 size-2 rounded-full bg-accent" />
        )}
      </button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Notifications"
        description="Les agents continuent leur travail même lorsque cette page est fermée."
      >
        <div className="grid gap-4">
          <div className="flex flex-wrap gap-2">
            <Button
              icon={<BellRing className="size-4" />}
              onClick={() => push.mutate()}
              loading={push.isPending}
              disabled={!pushSupported()}
            >
              {active
                ? "Désactiver le push sur cet appareil"
                : "Activer les notifications push"}
            </Button>
            {unread > 0 && (
              <Button
                icon={<CheckCheck className="size-4" />}
                onClick={() => mark.mutate(undefined)}
              >
                Tout marquer comme lu
              </Button>
            )}
          </div>
          {!pushSupported() && (
            <p className="text-sm text-muted">
              Les notifications push nécessitent HTTPS et un navigateur
              compatible.
            </p>
          )}
          <FormError error={push.error ?? q.error} />
          {!q.data?.length ? (
            <EmptyState
              title="Tout est à jour"
              hint="Les résultats des agents et les publications apparaîtront ici."
            />
          ) : (
            <ul className="max-h-[55vh] divide-y divide-line overflow-auto">
              {q.data.map((n) => (
                <li key={n.id}>
                  <Link
                    to={n.url}
                    onClick={() => {
                      mark.mutate(n.id);
                      setOpen(false);
                    }}
                    className={`block rounded-md px-3 py-4 hover:bg-line/50 ${n.readAt ? "" : "border-l-2 border-accent"}`}
                  >
                    <p className="text-sm font-medium">{n.title}</p>
                    <p className="mt-1 text-sm text-muted">{n.body}</p>
                    <p className="mt-1 text-xs text-faint">
                      {fmtDate(n.createdAt)}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
    </div>
  );
}
