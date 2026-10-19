import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export const json = (
  res: ServerResponse,
  code: number,
  value: unknown,
  headers: Record<string, string> = {},
) =>
  res
    .writeHead(code, { "content-type": "application/json", ...headers })
    .end(JSON.stringify(value));

export async function body(req: IncomingMessage, max = 100_000): Promise<any> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > max) throw new HttpError(413, "Requête trop volumineuse.");
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value;
  } catch {
    throw new HttpError(400, "JSON invalide.");
  }
}
