import { createHash, randomBytes } from "node:crypto";

// Même principe que les sessions : le jeton d'invitation n'est jamais stocké, seulement son empreinte.
export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
export const hashInviteToken = (t: string) => createHash("sha256").update(t).digest("hex");
export const newInviteToken = () => `inv_${randomBytes(24).toString("base64url")}`;
