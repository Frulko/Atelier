import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import type { Target } from "../../lib/scope";

/** Un lien vers une cible calculée par `useScope()` (dans le projet ou dans l'organisation). */
export function ScopedLink({ dest, ...rest }: { dest: Target } & Omit<ComponentProps<"a">, "href">) {
  const L = Link as unknown as (p: Record<string, unknown>) => React.JSX.Element;
  return <L {...dest} {...rest} />;
}
