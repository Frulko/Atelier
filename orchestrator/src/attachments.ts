// Pièces jointes d'un message de discussion. Une entrée NON FIABLE : le type annoncé, le nom et le contenu sont vérifiés ici.
// Les fichiers texte deviennent du texte (tous les fournisseurs les comprennent) ; images et PDF restent des fichiers pour le modèle.

export const MAX_FILES = 4;
export const MAX_FILE_BYTES = 4_000_000;
export const MAX_TOTAL_BYTES = 8_000_000;
export const MAX_TEXT_FILE_CHARS = 30_000;
export const MAX_BODY_BYTES = 12_000_000; // 8 Mo de fichiers en base64, plus le texte

const TEXT_TYPES = /^(text\/[a-z0-9.+-]+|application\/(json|xml|x-yaml|yaml|csv))$/;
const TEXT_EXT = /\.(txt|md|markdown|csv|json|ya?ml|xml|html?|css|js|mjs|ts|tsx|jsx|py|rb|php|go|rs|java|sql|sh|toml|ini|log)$/i;
const MAGIC: Record<string, (b: Buffer) => boolean> = {
  "image/png": (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8,
  "image/gif": (b) => b.subarray(0, 3).toString() === "GIF",
  "image/webp": (b) => b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP",
  "application/pdf": (b) => b.subarray(0, 5).toString() === "%PDF-",
};

export type Part = { type: "text"; text: string } | { type: "file"; mediaType: string; filename?: string; url: string };

const safeName = (n: unknown) => (typeof n === "string" ? n : "fichier").split(/[\\/]/).pop()!.replace(/[^\p{L}\p{N}._ ()-]/gu, "_").slice(0, 100) || "fichier";

/** Les parties « fichier » d'un message du navigateur, vérifiées et converties ; ou le message d'erreur à montrer. */
export function cleanAttachments(parts: unknown[]): { ok: true; parts: Part[] } | { ok: false; error: string } {
  const files = parts.filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && (p as { type?: unknown }).type === "file");
  if (files.length > MAX_FILES) return { ok: false, error: `${MAX_FILES} fichiers au plus par message` };
  const out: Part[] = []; let total = 0;
  for (const f of files) {
    const name = safeName(f.filename);
    const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(typeof f.url === "string" ? f.url : "");
    if (!m) return { ok: false, error: `« ${name} » : fichier illisible` };
    const bytes = Buffer.from(m[2]!, "base64");
    total += bytes.length;
    if (bytes.length > MAX_FILE_BYTES) return { ok: false, error: `« ${name} » dépasse ${MAX_FILE_BYTES / 1e6} Mo` };
    if (total > MAX_TOTAL_BYTES) return { ok: false, error: `${MAX_TOTAL_BYTES / 1e6} Mo de fichiers au plus par message` };
    const declared = m[1]!.toLowerCase();
    const check = MAGIC[declared];
    if (check) {
      if (!check(bytes)) return { ok: false, error: `« ${name} » : le contenu ne correspond pas au type annoncé` };
      out.push({ type: "file", mediaType: declared, filename: name, url: `data:${declared};base64,${m[2]}` });
    } else if (TEXT_TYPES.test(declared) || (declared === "application/octet-stream" && TEXT_EXT.test(name)) || TEXT_EXT.test(name)) {
      if (bytes.includes(0)) return { ok: false, error: `« ${name} » n'est pas un fichier texte` };
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      if (text.length > MAX_TEXT_FILE_CHARS) return { ok: false, error: `« ${name} » dépasse ${MAX_TEXT_FILE_CHARS} caractères` };
      // la clôture est plus longue que toute suite d'accents graves du fichier : il ne peut pas « sortir » de son bloc
      const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((x) => x[0].length + 1)));
      out.push({ type: "text", text: `Fichier joint « ${name} » :\n${fence}\n${text}\n${fence}` });
    } else return { ok: false, error: `« ${name} » : type non accepté (images, PDF et fichiers texte)` };
  }
  return { ok: true, parts: out };
}
