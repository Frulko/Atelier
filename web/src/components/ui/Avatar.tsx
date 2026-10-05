import clsx from "clsx";
import { initials } from "../../lib/format";

// Une teinte stable par personne, tirée du texte : la même personne a toujours la même couleur.
const hues = [18, 32, 150, 190, 222, 268, 330, 8];
export function Avatar({ name, size = 32, className }: { name: string | null | undefined; size?: number; className?: string }) {
  const h = hues[[...(name ?? "?")].reduce((n, c) => n + c.charCodeAt(0), 0) % hues.length]!;
  return (
    <span
      aria-hidden
      className={clsx("inline-grid shrink-0 place-items-center rounded-full font-mono text-[0.72em] font-medium text-[#1c1915]", className)}
      style={{ width: size, height: size, fontSize: size * 0.4, background: `oklch(0.86 0.09 ${h})` }}
    >
      {initials(name)}
    </span>
  );
}
