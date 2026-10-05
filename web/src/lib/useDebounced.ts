import { useEffect, useState } from "react";

/** Valeur retardée : la recherche n'interroge le serveur qu'une fois la frappe terminée. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
