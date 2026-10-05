import clsx from "clsx";
import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const base = "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45";
const variants: Record<Variant, string> = {
  primary: "bg-primary text-primary-ink shadow-xs hover:bg-primary/90",
  secondary: "border border-line-strong bg-raised text-ink shadow-xs hover:bg-line/50",
  ghost: "text-muted hover:bg-line/60 hover:text-ink",
  danger: "border border-bad/30 bg-bad-soft text-bad hover:border-bad/60",
};
const sizes: Record<Size, string> = { sm: "h-8 px-3 text-[13px]", md: "h-9 px-4 text-sm" };

export function Button({ variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode }) {
  return (
    <button type={type} disabled={disabled || loading} className={clsx(base, variants[variant], sizes[size], className)} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}
