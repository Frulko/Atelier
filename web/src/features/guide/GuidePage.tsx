import { Card, PageHeader, Section } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { FirstStepsList } from "./FirstSteps";
import { useTour } from "./Tour";

/** La boucle : parler, travailler, vérifier, relire. Texte alternatif complet : le schéma n'est jamais le seul porteur de sens. */
function Loop() {
  const items = [
    ["1", "Tu décris", "en français, comme à un collègue"],
    ["2", "L'agent travaille", "sur une copie, dans un bac à sable"],
    ["3", "Vérification", "la commande du projet doit passer"],
    ["4", "Proposition", "une branche et une demande de fusion"],
    ["5", "Tu relis", "et tu fusionnes, ou tu demandes un ajustement"],
  ] as const;
  return (
    <ol className="grid gap-3 sm:grid-cols-5" aria-label="La boucle d'une tâche">
      {items.map(([n, t, d], i) => (
        <li key={n} className="relative rounded-xl border border-line bg-raised p-4">
          <span className="mb-2 grid size-6 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-ink" aria-hidden>{n}</span>
          <p className="text-sm font-medium">{t}</p><p className="mt-0.5 text-[13px] text-muted">{d}</p>
          {i < items.length - 1 && <span className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 text-faint sm:block" aria-hidden>→</span>}
        </li>
      ))}
    </ol>
  );
}

const CAN = ["lire et modifier les fichiers d'une copie du projet", "lancer la vérification du projet, sans réseau", "te parler en français et suivre le CLAUDE.md du projet", "lire les connaissances que ton équipe a écrites"];
const CANNOT = ["voir un jeton git, une clé d'API ou un secret", "accéder à Internet", "publier, fusionner ou déployer", "toucher à ce que ton équipe a marqué comme protégé sans qu'un humain relise"];
const ROLES: [string, string][] = [["Lecteur", "voit les tâches, projets et connaissances"], ["Membre", "discute, lance des tâches, demande des ajustements"], ["Administrateur", "gère projets, connaissances, secrets, équipe, budget"], ["Propriétaire", "tout, y compris supprimer l'organisation"]];
const WORDS: [string, string][] = [
  ["Tâche", "une demande confiée à l'agent. C'est aussi une conversation."],
  ["Bac à sable", "un conteneur jetable, sans secret ni Internet, où l'agent travaille."],
  ["Branche", "une version parallèle du code où la proposition est préparée."],
  ["Demande de fusion", "la proposition soumise à relecture sur GitLab ou GitHub (merge request / pull request)."],
  ["Vérification", "la commande du projet (tests, contrôle de syntaxe) qui doit réussir."],
  ["Chemin protégé", "un fichier ou dossier dont toute modification exige une relecture humaine."],
  ["Connaissance", "un court texte que l'assistant et l'agent lisent avant de travailler."],
];
const FAQ: [string, string][] = [
  ["L'agent peut-il casser mon site ?", "Non : il travaille sur une copie, et rien n'est fusionné sans qu'une personne relise. Au pire, tu refuses la proposition."],
  ["Que devient ma demande si la vérification échoue ?", "L'agent la reçoit avec le message d'erreur et corrige, jusqu'à trois essais. Si elle échoue encore, la tâche est en échec et rien n'est envoyé."],
  ["Quelle différence entre Discuter et Tâche ?", "Discuter ne modifie rien : l'assistant répond. Une tâche confie le travail à l'agent, qui modifie le code et prépare une proposition."],
  ["Combien ça coûte ?", "Chaque tâche affiche le coût déclaré par l'agent. Un administrateur peut fixer un plafond mensuel pour l'organisation."],
  ["Qui voit mes discussions ?", "Toi seul : même un administrateur ne les voit pas. Les tâches, elles, sont visibles de toute l'équipe."],
];

export function GuidePage() {
  const tour = useTour();
  return (
    <>
      <PageHeader title="Guide" subtitle="Comment Atelier fonctionne, et un cas concret pour te prendre par la main."
        actions={<Button onClick={tour.start}>Revoir la visite guidée</Button>} />
      <Section title="Premiers pas" hint="Une boulangerie veut une page Contact sur son site. Chaque étape se coche toute seule." className="mb-10"><Card className="p-5"><FirstStepsList /></Card></Section>
      <Section title="Comment ça marche" hint="Rien n'est publié sans qu'une personne relise." className="mb-10"><Loop /></Section>
      <div className="mb-10 grid gap-8 md:grid-cols-2">
        <Section title="Discuter ou Tâche ?">
          <Card className="grid gap-3 p-5 text-sm">
            <p><strong>Discuter</strong> : un assistant répond, cite ses sources et t'aide à préparer une demande. Il ne modifie rien. Tes discussions sont privées.</p>
            <p><strong>Tâche</strong> : l'agent modifie le code dans un bac à sable et prépare une proposition. Ensuite, écris-lui pour demander des ajustements : il reprend la même proposition.</p>
            <p className="text-muted">Une discussion peut devenir une tâche d'un clic : « Lancer comme tâche ».</p>
          </Card>
        </Section>
        <Section title="Ce que l'agent peut faire, ou non">
          <Card className="grid gap-4 p-5 text-sm sm:grid-cols-2">
            <div><p className="mb-1.5 font-medium text-ok">Il peut</p><ul className="grid list-disc gap-1 pl-4 text-muted">{CAN.map((x) => <li key={x}>{x}</li>)}</ul></div>
            <div><p className="mb-1.5 font-medium text-bad">Il ne peut pas</p><ul className="grid list-disc gap-1 pl-4 text-muted">{CANNOT.map((x) => <li key={x}>{x}</li>)}</ul></div>
          </Card>
        </Section>
      </div>
      <div className="mb-10 grid gap-8 md:grid-cols-2">
        <Section title="Les rôles"><Card className="divide-y divide-line">{ROLES.map(([r, d]) => <div key={r} className="flex gap-3 px-4 py-3 text-sm"><span className="w-32 shrink-0 font-medium">{r}</span><span className="text-muted">{d}</span></div>)}</Card></Section>
        <Section title="Le vocabulaire"><Card className="divide-y divide-line">{WORDS.map(([w, d]) => <div key={w} className="px-4 py-3 text-sm"><dt className="inline font-medium">{w}</dt><dd className="inline text-muted"> — {d}</dd></div>)}</Card></Section>
      </div>
      <Section title="Questions fréquentes" className="mb-4">
        <Card className="divide-y divide-line">{FAQ.map(([q, a]) => <details key={q} className="group px-4 py-3 text-sm"><summary className="cursor-pointer font-medium marker:text-muted">{q}</summary><p className="mt-2 text-muted">{a}</p></details>)}</Card>
      </Section>
    </>
  );
}
