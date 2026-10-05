import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const base = "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-[10px] font-medium transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink shadow-[inset_0_-2px_0_rgb(0_0_0/0.18)] hover:brightness-110",
  secondary: "border border-line-strong bg-raised text-ink hover:border-ink",
  ghost: "text-muted hover:bg-line/60 hover:text-ink",
  danger: "border border-bad/40 bg-bad-soft text-bad hover:border-bad",
};
const sizes: Record<Size, string> = { sm: "h-8 px-3 text-[13px]", md: "h-10 px-4 text-sm" };

export function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }) {
  return (
    <button type={type} disabled={disabled || loading} className={clsx(base, variants[variant], sizes[size], className)} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}
