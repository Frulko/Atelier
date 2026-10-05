/** Retire les clés indéfinies : les paramètres d'URL deviennent vraiment facultatifs pour le routeur (liens sans `search`). */
export const compact = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

export const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
export const pageNo = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
export const safePath = (v: unknown) => (typeof v === "string" && v.startsWith("/") && !v.startsWith("//") ? v : undefined);
