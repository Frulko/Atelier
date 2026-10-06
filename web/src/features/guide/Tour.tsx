import { useNavigate } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { useOrg } from "../../lib/useOrg";

type Step = { target?: string; title: string; text: string };

const STEPS: Step[] = [
  { title: "Bienvenue dans Atelier", text: "Tu décris un changement en français. Un agent le prépare dans un bac à sable, sur une copie du projet. Tu relis la proposition, puis tu la valides. Rien n'est publié sans toi." },
  { target: "org-switcher", title: "Ton organisation", text: "Tout ce que tu vois appartient à une organisation : ses projets, ses connaissances, son équipe. Tu peux en avoir plusieurs et passer de l'une à l'autre ici." },
  { target: "nav-conversations", title: "Discuter ou confier une tâche", text: "Une conversation a deux modes. « Discuter » : un assistant répond et t'aide à préparer ta demande, sans rien modifier. « Tâche » : l'agent modifie le code, et tu peux lui demander des ajustements ensuite." },
  { target: "nav-knowledge", title: "Les connaissances", text: "Le ton du site, les couleurs, les règles de l'équipe : écris-les une fois, l'assistant et l'agent les liront à chaque fois. Tu vois toujours lesquelles ont servi." },
  { target: "nav-projects", title: "Les projets", text: "Un projet, c'est un dépôt de code relié à Atelier. Chacun a sa vérification automatique et ses chemins protégés, qui exigent toujours une relecture humaine." },
  { target: "projects-health", title: "L'état en un coup d'œil", text: "Pour chaque projet : le site est-il en ligne, quel est le dernier changement, et la dernière tâche. Le bouton Actualiser relit tout de suite." },
  { target: "nav-tasks", title: "Le suivi des tâches", text: "Toutes les tâches de l'équipe, avec leur état, leur coût et le journal de ce que l'agent a fait." },
  { target: "nav-guide", title: "Besoin d'un coup de main ?", text: "Le guide explique le fonctionnement, et « Premiers pas » te fait faire un cas concret pas à pas : une boulangerie qui veut une page Contact." },
];

const KEY = (userId: string) => `atelier.tour.${userId}`;
const DISABLED = "atelier.tour.disabled";
const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible : la visite se reproposera */ } };

const Ctx = createContext<{ start: () => void }>({ start: () => {} });
export const useTour = () => useContext(Ctx);

const visible = (el: Element | null): el is HTMLElement => !!el && (el as HTMLElement).getClientRects().length > 0;
const find = (name: string) => [...document.querySelectorAll(`[data-tour="${name}"]`)].find(visible) ?? null;

/**
 * Visite guidée : un projecteur sur les vraies zones de l'interface, une phrase par étape. Sans dépendance. Se lance à la
 * première connexion (une fois par personne et par navigateur), se rejoue depuis le guide. Clavier : flèches, Entrée, Échap.
 * Une étape dont la zone n'est pas à l'écran (menu replié sur téléphone, page différente) est sautée.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const { me } = useOrg();
  const userId = me?.user.id;
  const [at, setAt] = useState<number | null>(null);
  const start = useCallback(() => setAt(0), []);

  useEffect(() => {
    if (!userId || read(DISABLED) || read(KEY(userId))) return;
    const t = setTimeout(() => setAt(0), 700);
    return () => clearTimeout(t);
  }, [userId]);

  const close = useCallback(() => { if (userId) write(KEY(userId), "done"); setAt(null); }, [userId]);
  const value = useMemo(() => ({ start }), [start]);
  return <Ctx.Provider value={value}>{children}{at !== null && <TourOverlay index={at} setIndex={setAt} close={close} />}</Ctx.Provider>;
}

function TourOverlay({ index, setIndex, close }: { index: number; setIndex: (i: number | null) => void; close: () => void }) {
  const { orgId } = useOrg();
  const navigate = useNavigate();
  // les étapes réellement affichables, calculées une fois à l'ouverture
  const steps = useMemo(() => STEPS.filter((s) => !s.target || find(s.target)), []);
  const step = steps[index];
  const [rect, setRect] = useState<DOMRect | null>(null);
  const next = useRef<HTMLButtonElement>(null);
  const last = index === steps.length - 1;

  const measure = useCallback(() => {
    const el = step?.target ? find(step.target) : null;
    setRect(el ? el.getBoundingClientRect() : null);
  }, [step]);
  useLayoutEffect(() => {
    const el = step?.target ? find(step.target) : null;
    el?.scrollIntoView({ block: "nearest" });
    measure();
    window.addEventListener("resize", measure); window.addEventListener("scroll", measure, true);
    return () => { window.removeEventListener("resize", measure); window.removeEventListener("scroll", measure, true); };
  }, [step, measure]);
  useEffect(() => { next.current?.focus(); }, [index]);

  const go = useCallback((d: number) => { const n = index + d; if (n < 0) return; if (n >= steps.length) return finish(); setIndex(n); }, [index, steps.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const finish = () => { close(); navigate({ to: "/o/$orgId/guide", params: { orgId } }); };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "Tab") { // le focus reste dans la fenêtre de la visite
        const f = [...document.querySelectorAll<HTMLElement>("[data-tour-dialog] button")];
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]!.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [go, close]);

  if (!step) return null;
  const W = 340, pad = 6, vw = window.innerWidth, vh = window.innerHeight;
  // à droite de la zone si la place le permet (menu latéral), sinon en dessous ; centrée quand il n'y a pas de zone
  const pos = rect
    ? rect.right + W + 24 < vw ? { left: rect.right + 16, top: Math.max(12, Math.min(rect.top, vh - 260)) }
      : { left: Math.max(12, Math.min(rect.left, vw - W - 12)), top: Math.min(rect.bottom + 14, vh - 260) }
    : { left: Math.max(12, (vw - W) / 2), top: Math.max(12, vh / 2 - 130) };

  return (
    <div className="fixed inset-0 z-[60]" data-testid="tour">
      <div className="absolute inset-0" aria-hidden onClick={(e) => e.stopPropagation()} />
      {rect
        ? <div aria-hidden className="pointer-events-none fixed rounded-lg motion-safe:transition-all motion-safe:duration-200" style={{ left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2, boxShadow: "0 0 0 9999px rgb(9 9 11 / 0.55), 0 0 0 2px var(--accent)" }} />
        : <div aria-hidden className="pointer-events-none fixed inset-0 bg-black/55" />}
      <div role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text" data-tour-dialog
        className="fixed grid gap-3 rounded-xl border border-line bg-raised p-5 shadow-[var(--shadow-pop)]" style={{ ...pos, width: Math.min(W, vw - 24) }}>
        <p className="text-xs font-medium text-muted" aria-live="polite">Étape {index + 1} sur {steps.length}</p>
        <h2 id="tour-title" className="font-display text-base">{step.title}</h2>
        <p id="tour-text" className="text-sm leading-relaxed text-muted">{step.text}</p>
        <div className="mt-1 flex items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={close}>Passer</Button>
          <div className="flex gap-2">
            {index > 0 && <Button size="sm" onClick={() => go(-1)}>Précédent</Button>}
            <button ref={next} type="button" onClick={() => go(1)} className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-[13px] font-medium text-primary-ink shadow-xs hover:bg-primary/90">{last ? "Commencer les premiers pas" : "Suivant"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
