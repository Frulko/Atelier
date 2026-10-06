import "./nonce";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import TsWorker from "monaco-editor/language/typescript/ts.worker?worker";

// Monaco est embarqué avec l'application (aucun CDN) : ses « workers » sont des fichiers de notre propre origine, donc couverts par la CSP.
(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

// Pas de vérification sémantique TypeScript/JavaScript : l'éditeur ne connaît pas les dépendances du projet, il ne faut pas de faux avertissements.
const noSemantic = { noSemanticValidation: true, noSyntaxValidation: false };
// ponytail: le typage de ce module a changé selon les versions de Monaco ; on y accède sans le typer
const ts = ((monaco as unknown as { typescript?: unknown }).typescript ?? (monaco.languages as unknown as { typescript?: unknown }).typescript) as { javascriptDefaults?: { setDiagnosticsOptions(o: unknown): void }; typescriptDefaults?: { setDiagnosticsOptions(o: unknown): void } } | undefined;
ts?.javascriptDefaults?.setDiagnosticsOptions?.(noSemantic);
ts?.typescriptDefaults?.setDiagnosticsOptions?.(noSemantic);

export { monaco };

const EXT: Record<string, string> = { js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", json: "json", md: "markdown", css: "css", scss: "scss", html: "html", htm: "html", xml: "xml", yml: "yaml", yaml: "yaml", py: "python", rb: "ruby", php: "php", go: "go", rs: "rust", java: "java", sql: "sql", sh: "shell", toml: "ini", ini: "ini", csv: "plaintext", txt: "plaintext" };
export const languageOf = (path: string) => EXT[path.split(".").pop()?.toLowerCase() ?? ""] ?? "plaintext";
