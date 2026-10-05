import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

/** Boîte de dialogue native (<dialog>) : focus piégé, Échap et fond cliquable gérés par le navigateur. */
export function Dialog({ open, onClose, title, description, children, wide }: { open: boolean; onClose: () => void; title: string; description?: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={`m-auto rounded-xl border-0 bg-surface p-0 text-ink shadow-pop backdrop:bg-black/50 backdrop:backdrop-blur-[2px] ${wide ? "w-[min(92vw,44rem)]" : "w-[min(92vw,30rem)]"}`}
    >
      {open && (
        <div className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <h2 className="font-display text-xl">{title}</h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Fermer" className="rounded-lg p-1.5 text-muted hover:bg-line/70 hover:text-ink"><X className="size-4" /></button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
