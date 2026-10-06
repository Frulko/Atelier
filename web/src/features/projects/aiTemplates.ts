/** Modèles de départ des fichiers d'IA d'un projet. Courts, en français, à adapter : ce sont des points de départ, pas des vérités. */
export type TemplateKey = "claude" | "agents" | "rule" | "skill" | "subagent";

export const TEMPLATES: Record<TemplateKey, (name: string) => string> = {
  claude: () => `# Ce projet

Décris en deux phrases ce que fait le projet et pour qui.

## Lancer et vérifier
- Lancer : \`\`
- Vérifier (doit passer avant toute proposition) : \`\`

## Conventions
- Langue des textes visibles : français.
- Fais le plus petit changement qui répond à la demande.
- Respecte le style du code autour de ta modification.

## À ne jamais faire
- Ne modifie pas les fichiers de configuration de déploiement ni les migrations sans que la demande le dise.
- N'ajoute pas de dépendance sans raison claire.
`,
  agents: () => `# AGENTS.md

Consignes pour les assistants de code qui travaillent sur ce dépôt (partagées entre outils).

## Commandes
- Installer : \`\`
- Tester : \`\`

## Règles
- Petits changements, faciles à relire.
- Explique en une phrase ce que tu as changé et pourquoi.
`,
  rule: (n) => `# Règle : ${n}

Quand cette règle s'applique, et ce qu'il faut faire (ou ne pas faire).

- …
`,
  skill: (n) => `---
name: ${n}
description: Quand utiliser cette compétence, en une phrase (l'agent la choisit d'après ce texte).
---

# ${n}

Étapes à suivre, dans l'ordre :

1. …
2. …
`,
  subagent: (n) => `---
name: ${n}
description: Ce que fait ce sous-agent et quand lui déléguer.
---

Tu es un spécialiste : décris ici son rôle, ce qu'il regarde en priorité et comment il rend son résultat.
`,
};

export const GENERATE_PROMPT: Record<"claude" | "agents", string> = {
  claude: "Analyse ce dépôt et rédige un fichier CLAUDE.md à la racine : ce qu'est le projet, comment le lancer et le vérifier, les conventions de code, et ce qu'il ne faut jamais modifier. Reste court, factuel, sans rien inventer.",
  agents: "Analyse ce dépôt et rédige un fichier AGENTS.md à la racine pour les assistants de code : commandes pour installer, lancer et tester, conventions, pièges connus. Reste court et factuel.",
};

export type AiKind = "claude" | "agents" | "rule" | "skill" | "subagent";
export const kindOf = (path: string): AiKind => path === "CLAUDE.md" ? "claude" : path === "AGENTS.md" ? "agents" : path.startsWith(".claude/rules/") ? "rule" : path.startsWith(".claude/skills/") ? "skill" : "subagent";
/** Le nom d'une règle, d'une skill ou d'un sous-agent : lettres, chiffres, tirets (devient un nom de fichier ou de dossier). */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const pathFor = (kind: "rule" | "skill" | "subagent", name: string) => kind === "rule" ? `.claude/rules/${name}.md` : kind === "skill" ? `.claude/skills/${name}/SKILL.md` : `.claude/agents/${name}.md`;
