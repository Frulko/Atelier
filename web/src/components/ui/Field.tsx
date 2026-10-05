import clsx from "clsx";
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { useId } from "react";

const control = "w-full rounded-md border border-line-strong bg-raised px-3 text-sm text-ink shadow-xs placeholder:text-faint transition focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent/20 disabled:opacity-50";

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode; className?: string }) {
  const id = useId();
  return (
    <div className={clsx("grid gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-ink">{label}</label>
      {children(id)}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && <p role="alert" className="text-xs font-medium text-bad">{error}</p>}
    </div>
  );
}

export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input className={clsx(control, "h-9", className)} {...p} />;
export const Select = ({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={clsx(control, "h-9 pr-8", className)} {...p}>{children}</select>;
export const Textarea = ({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea className={clsx(control, "min-h-24 resize-y py-2.5 leading-relaxed", className)} {...p} />;
