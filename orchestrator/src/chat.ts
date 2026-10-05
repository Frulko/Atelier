import type { Part } from "./attachments.ts";
import type { ServerResponse } from "node:http";
import { convertToModelMessages, streamText, type LanguageModel, type UIMessage } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { cfg } from "./config.ts";
import {
  DEFAULT_TITLE, deleteTrailingAssistant, getMessages, getOrg, getProjectInOrg, insertMessage, listKnowledge, setConversationTitle,
  type ConversationRow, type MessageRow, type ProjectRow,
} from "./db.ts";
import { renderKnowledge, selectKnowledge } from "./knowledge.ts";
import { providerKey } from "./vault.ts";

/*
 * Discussion avec l'assistant : le modèle est appelé DEPUIS L'ORCHESTRATEUR (pas depuis un bac à sable), avec la clé
 * de l'organisation lue dans le coffre à l'instant de l'appel. Le SDK d'IA de Vercel fournit le flux ; le navigateur le
 * consomme avec useChat. L'historique envoyé au modèle vient de NOTRE base, jamais du navigateur : un client ne peut
 * pas fabriquer de fausses réponses de l'assistant ni d'anciens messages.
 */
export const CHAT_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];
export const DEFAULT_CHAT = { provider: "anthropic" as ChatProvider, model: "claude-sonnet-5-5" };
export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_MESSAGES = 500;
const WINDOW_MESSAGES = 40, WINDOW_CHARS = 60_000;

export const effectiveChat = (org: { chat_provider: string | null; chat_model: string | null } | undefined) => ({
  provider: (CHAT_PROVIDERS as readonly string[]).includes(org?.chat_provider ?? "") ? (org!.chat_provider as ChatProvider) : DEFAULT_CHAT.provider,
  model: org?.chat_model || DEFAULT_CHAT.model,
});

const upstream = (name: string) => process.env[`ATELIER_UPSTREAM_${name}`]; // tests : un faux fournisseur local

type Resolved = { ok: true; model: LanguageModel; provider: string; modelId: string } | { ok: false; status: number; error: string };

export async function resolveModel(orgId: string, system?: () => string): Promise<Resolved> {
  const { provider, model: modelId } = effectiveChat(getOrg(orgId));
  if (cfg.fakeAgent) return { ok: true, model: await fakeModel(), provider: "demo", modelId: "modèle-factice" };
  const apiKey = providerKey(orgId, provider);
  if (!apiKey) return { ok: false, status: 409, error: `Aucune clé « ${provider} » n'est configurée pour cette organisation : un administrateur peut en ajouter une dans Intégrations.` };
  void system;
  if (provider === "anthropic") { const up = upstream("ANTHROPIC"); return { ok: true, model: createAnthropic({ apiKey, ...(up ? { baseURL: `${up}/v1` } : {}) })(modelId), provider, modelId }; }
  if (provider === "openai") { const up = upstream("OPENAI"); return { ok: true, model: createOpenAI({ apiKey, ...(up ? { baseURL: `${up}/v1` } : {}) })(modelId), provider, modelId }; }
  const up = upstream("OPENROUTER") ?? "https://openrouter.ai/api";
  return { ok: true, model: createOpenAICompatible({ name: "openrouter", apiKey, baseURL: `${up}/v1` })(modelId), provider, modelId };
}

/** Assistant factice : aucune IA, aucune clé. Il répète la demande et liste les connaissances reçues (la démonstration montre ainsi qu'elles arrivent bien). */
async function fakeModel(): Promise<LanguageModel> {
  const { MockLanguageModelV3, simulateReadableStream } = await import("ai/test");
  return new MockLanguageModelV3({
    doStream: async (options) => {
      const system = options.prompt.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      const lastUser = [...options.prompt].reverse().find((m) => m.role === "user");
      const parts = Array.isArray(lastUser?.content) ? lastUser!.content : [];
      const asked = parts.map((p) => (p.type === "text" ? p.text : "")).join(" ");
      const attached = parts.filter((p) => p.type === "file").length;
      const known = [...(system.split("# Connaissances de l'organisation")[1] ?? "").matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
      const project = /^# Projet : (.+)$/m.exec(system)?.[1];
      const text = [
        "**Réponse factice** — aucun modèle n'a été appelé (mode démonstration).",
        `Tu as écrit : « ${asked.trim().slice(0, 300)} ».`,
        project ? `Projet : ${project}.` : "Aucun projet n'est rattaché à cette discussion.",
        ...(/\bcode\b/i.test(asked) ? ["```html\n<a href=\"/contact\">Contact</a>\n```"] : []),
        ...(attached ? [`Pièces jointes reçues : ${attached}.`] : []),
        known.length ? `Connaissances reçues :\n${known.map((k) => `- ${k}`).join("\n")}` : "Aucune connaissance n'a été fournie.",
      ].join("\n\n");
      const words = text.split(/(\s+)/);
      const tokens = (n: number) => Math.ceil(n / 4);
      const chunks: LanguageModelV3StreamPart[] = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t" },
        ...words.map((w): LanguageModelV3StreamPart => ({ type: "text-delta", id: "t", delta: w })),
        { type: "text-end", id: "t" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: tokens(system.length + asked.length), noCache: tokens(system.length + asked.length), cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: tokens(text.length), text: tokens(text.length), reasoning: undefined } } },
      ];
      return { stream: simulateReadableStream({ initialDelayInMs: 30, chunkDelayInMs: 8, chunks }) };
    },
  });
}

export function buildSystem(project: ProjectRow | undefined, knowledgeText: string): string {
  return [
    "Tu es l'assistant d'Atelier, une plateforme où des équipes font évoluer leur logiciel en parlant à un agent.",
    "Tu réponds en français, de façon claire et concise, en Markdown quand c'est utile.",
    "Dans cette discussion tu ne peux PAS modifier le code ni lire le dépôt. Si la personne veut qu'un changement soit réalisé, aide-la à formuler une demande précise et propose de la lancer comme tâche : l'agent, lui, peut lire et modifier le code.",
    "N'invente jamais de détails sur du code que tu ne vois pas : dis-le quand tu ne sais pas.",
    project ? [`# Projet : ${project.name}`, `- Dépôt : ${project.repo}`, `- Branche de base : ${project.branch}`, `- Vérification automatique : ${project.check_cmd}`, `- Chemins protégés (relecture obligatoire) : ${JSON.parse(project.protected_paths).join(", ") || "aucun"}`].join("\n") : "",
    knowledgeText,
  ].filter(Boolean).join("\n\n");
}

export const toUIMessage = (r: MessageRow): UIMessage => ({ id: r.id, role: r.role, parts: JSON.parse(r.parts), ...(r.meta ? { metadata: JSON.parse(r.meta) } : {}) }) as UIMessage;
export const textOf = (m: Pick<UIMessage, "parts"> | undefined) => (m?.parts ?? []).map((p) => (p.type === "text" ? p.text : "")).join("").trim();
export const titleFrom = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 60) || DEFAULT_TITLE;

/** Fenêtre envoyée au modèle : les messages les plus récents, dans une limite de nombre et de taille, en commençant par une question. */
export function windowMessages(history: UIMessage[]): UIMessage[] {
  const out: UIMessage[] = []; let chars = 0;
  for (let i = history.length - 1; i >= 0 && out.length < WINDOW_MESSAGES; i--) {
    const n = textOf(history[i]).length;
    if (out.length && chars + n > WINDOW_CHARS) break;
    out.unshift(history[i]!); chars += n;
  }
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

/** Message d'erreur montré à la personne : jamais le texte brut du fournisseur (il peut contenir des détails internes). */
export function friendlyError(e: unknown): string {
  const t = String((e as { message?: string })?.message ?? e).toLowerCase(), code = Number((e as { statusCode?: number })?.statusCode);
  if (code === 401 || code === 403 || /api key|authentication|unauthorized|invalid x-api-key/.test(t)) return "Le fournisseur a refusé la clé de l'organisation. Un administrateur peut la remplacer dans Intégrations.";
  if (code === 429 || /rate limit|overloaded|too many/.test(t)) return "Le fournisseur est saturé pour le moment. Réessaie dans un instant.";
  if (code === 404 || /model.*(not found|does not exist)|not_found/.test(t)) return "Le fournisseur ne connaît pas ce modèle. Un administrateur peut en choisir un autre dans Organisation.";
  return "Le modèle n'a pas pu répondre. Réessaie dans un instant.";
}

/**
 * Lance la réponse de l'assistant et la diffuse vers `res`. `text` : nouvelle question ; `null` : régénérer la dernière réponse.
 * Rend une erreur à renvoyer AVANT tout flux (clé absente…), ou null si le flux est parti.
 */
export async function runChat(o: { res: ServerResponse; conv: ConversationRow; orgId: string; text: string | null; files?: Part[]; signal: AbortSignal }): Promise<{ status: number; error: string } | null> {
  const m = await resolveModel(o.orgId);
  if (!m.ok) return { status: m.status, error: m.error };
  const project = o.conv.project_id ? getProjectInOrg(o.conv.project_id, o.orgId) : undefined;

  if (o.text !== null) {
    const files = o.files ?? [];
    insertMessage(o.conv.id, "user", [...(o.text ? [{ type: "text", text: o.text }] : []), ...files]);
    const named = o.text || (files.find((f) => f.type === "file") as { filename?: string } | undefined)?.filename || "";
    if (o.conv.title === DEFAULT_TITLE && named) setConversationTitle(o.conv.id, titleFrom(named));
  } else deleteTrailingAssistant(o.conv.id);

  const history = getMessages(o.conv.id).map(toUIMessage);
  const question = textOf([...history].reverse().find((x) => x.role === "user"));
  const sel = selectKnowledge(listKnowledge(o.orgId), o.conv.project_id, question);
  const sources = sel.chosen.map((k) => ({ id: k.id, title: k.title }));
  const system = buildSystem(project, renderKnowledge(sel.chosen));

  const result = streamText({ model: m.model, system, messages: await convertToModelMessages(windowMessages(history)), abortSignal: o.signal, maxOutputTokens: 4096 });
  result.pipeUIMessageStreamToResponse(o.res, {
    originalMessages: history,
    messageMetadata: ({ part }) => (part.type === "start" ? { sources, model: m.modelId, provider: m.provider } : undefined),
    onError: (e) => { console.warn(`chat: ${(e as Error)?.message ?? e}`); return friendlyError(e); },
    onEnd: async ({ responseMessage, isAborted }) => {
      if (!responseMessage.parts.length) return; // rien n'a été produit : rien à enregistrer
      let usage: { inputTokens?: number; outputTokens?: number } = {};
      try { const u = await result.totalUsage; usage = { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 }; } catch { /* arrêté avant la fin */ }
      insertMessage(o.conv.id, "assistant", responseMessage.parts, { sources, model: m.modelId, provider: m.provider, usage, ...(isAborted ? { aborted: true } : {}) });
    },
  });
  return null;
}
