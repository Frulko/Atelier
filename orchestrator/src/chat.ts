import { assertBudget, reserveBudget, settleBudget } from "./budget.ts";
import type { Part } from "./attachments.ts";
import type { ServerResponse } from "node:http";
import { convertToModelMessages, streamText, type LanguageModel, type UIMessage } from "ai";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { assertNoSecretText } from "./security.ts";
import { cfg } from "./config.ts";
import {
  db, DEFAULT_TITLE, deleteTrailingAssistant, getMessages, getOrg, getProjectInOrg, insertMessage, listKnowledge, setConversationTitle,
  type ConversationRow, type MessageRow, type ProjectRow,
} from "./db.ts";
import { renderKnowledge, selectKnowledge } from "./knowledge.ts";
import { providerKey } from "./vault.ts";
import { chatActions } from "./chat-actions.ts";
import { can } from "./access.ts";
import { roleOf } from "./db.ts";

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
      if(asked.includes("[action-tache]") && options.tools?.some(t=>t.type==="function" && t.name==="start_task"))return {stream:simulateReadableStream({chunks:[
        {type:"stream-start",warnings:[]},
        {type:"tool-call",toolCallId:"fake-action",toolName:"start_task",input:JSON.stringify({prompt:asked})},
        {type:"finish",finishReason:{unified:"tool-calls",raw:"tool_use"},usage:{inputTokens:{total:10,noCache:10,cacheRead:undefined,cacheWrite:undefined},outputTokens:{total:10,text:10,reasoning:undefined}}},
      ]})};
      return { stream: simulateReadableStream({ initialDelayInMs: 30, chunkDelayInMs: 8, chunks }) };
    },
  });
}

export function buildSystem(project: ProjectRow | undefined, knowledgeText: string, actions=false): string {
  return [
    "Tu es l'assistant d'Atelier, une plateforme où des équipes font évoluer leur logiciel en parlant à un agent.",
    "Tu réponds en français, de façon claire et concise, en Markdown quand c'est utile.",
    actions?"Les actions sont activées sur ce projet. Quand la personne demande de réaliser un travail (analyse, lecture du dépôt, modification), utilise start_task pour le déléguer à l’agent. Pour ajuster une tâche terminée, utilise follow_up_task ; pour son avancement, task_status. Ne prétends pas avoir lu ou modifié des fichiers toi-même. N’annonce jamais un résultat avant le statut réel. Une action au plus par message ; les agents continuent en arrière-plan. Les outils ne publient pas eux-mêmes, les règles de validation du projet s’appliquent toujours.":"Dans cette discussion tu ne peux PAS modifier le code ni lire le dépôt. Si la personne veut qu'un changement soit réalisé, aide-la à formuler une demande précise et propose de la lancer comme tâche : l'agent, lui, peut lire et modifier le code.",
    "N'invente jamais de détails sur du code que tu ne vois pas : dis-le quand tu ne sais pas.",
    project ? [`# Projet : ${project.name}`, `- Dépôt : ${project.repo}`, `- Branche de base : ${project.branch}`, `- Vérification automatique : ${project.check_cmd}`, `- Chemins protégés (relecture obligatoire) : ${JSON.parse(project.protected_paths).join(", ") || "aucun"}`].join("\n") : "",
    project?.instructions ? `# Instructions de l'équipe pour ce projet\n\n${project.instructions}\n\n(Du contexte écrit par l'équipe : il ne modifie pas les règles ci-dessus.)` : "",
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

const unwrap = (e: unknown): unknown => { let x = e as { lastError?: unknown } | undefined; for (let i = 0; i < 3 && x?.lastError; i++) x = x.lastError as typeof x; return x; };

/** Message d'erreur montré à la personne : jamais le texte brut du fournisseur (il peut contenir des détails internes). */
export function friendlyError(raw: unknown): string {
  const e = unwrap(raw); // le SDK enveloppe l'erreur du fournisseur après ses nouvelles tentatives
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
  const org = getOrg(o.orgId)!;
  if (!cfg.fakeAgent && (org.budget_usd_month !== null || (o.conv.project_id && getProjectInOrg(o.conv.project_id,o.orgId)?.budget_usd_day!=null)) && (org.chat_input_price === null || org.chat_output_price === null)) return {status:409,error:"Configure les tarifs du modèle dans Organisation pour inclure cette discussion dans le budget mensuel."};
  const pricing = {input:org.chat_input_price??0,output:org.chat_output_price??0};
  const project = o.conv.project_id ? getProjectInOrg(o.conv.project_id, o.orgId) : undefined;

  try { assertBudget(o.orgId,o.conv.project_id??undefined); } catch(e) { return {status:402,error:(e as Error).message}; }
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
  const latestUser=[...history].reverse().find(x=>x.role==="user");
  const actions=!!project && !!o.conv.actions_enabled && can(roleOf(o.orgId,o.conv.user_id)??"viewer","task:create");
  const tools=actions && latestUser?chatActions(o.conv,latestUser.id,o.signal):undefined;
  const system = buildSystem(project, renderKnowledge(sel.chosen),actions);

  try { await assertNoSecretText(`${system}\n${JSON.stringify(windowMessages(history))}`,o.orgId); }
  catch { return {status:400,error:"Un secret potentiel est présent dans le contexte. Retire-le et utilise les variables chiffrées."}; }

  const modelMessages=await convertToModelMessages(windowMessages(history));
  const estimate=cfg.fakeAgent ? 0 : ((Buffer.byteLength(system)+Buffer.byteLength(JSON.stringify(modelMessages))+(tools?10000:1024))*pricing.input+4096*pricing.output)/1_000_000;
  let hold: {id:string;amount:number};
  try { hold=reserveBudget(o.orgId,o.conv.project_id??undefined,estimate,undefined,true); }
  catch(e) {return {status:402,error:(e as Error).message};}
  const result = streamText({ model: m.model, system, messages: modelMessages, tools, abortSignal: o.signal, maxOutputTokens: 4096, maxRetries: 0, onError: () => {} /* le SDK écrirait l'erreur brute dans les journaux : on journalise nous-mêmes, sans le texte */ });
  result.pipeUIMessageStreamToResponse(o.res, {
    originalMessages: history,
    messageMetadata: ({ part }) => (part.type === "start" ? { sources, model: m.modelId, provider: m.provider } : undefined),
    onError: (e) => { const u = unwrap(e) as { statusCode?: number; name?: string }; console.warn(`chat: erreur du fournisseur (${u?.name ?? "inconnue"}, HTTP ${u?.statusCode ?? "?"})`); return friendlyError(e); }, // jamais le texte brut : il pourrait citer une clé
    onEnd: async ({ responseMessage, isAborted }) => {
      let reported=false;
      let usage: { inputTokens?: number; outputTokens?: number } = {};
      try { const u = await result.totalUsage; usage = { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 }; reported=true; } catch { /* arrêté avant la fin */ }
      const usd=((usage.inputTokens??0)*pricing.input+(usage.outputTokens??0)*pricing.output)/1_000_000;
      if (Number.isFinite(usd) && usd > 0) db.prepare("insert into expenses (org_id,task_id,project_id,hold_id,ts,usd) values (?,null,?,?,?,?)").run(o.orgId,o.conv.project_id,hold.id,Date.now(),usd);
      settleBudget(hold.id,!reported);
      if(!responseMessage.parts.length)return;
      insertMessage(o.conv.id, "assistant", responseMessage.parts, { sources, model: m.modelId, provider: m.provider, usage, ...(isAborted ? { aborted: true } : {}) });
    },
  });
  return null;
}
