import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Fusion de classes Tailwind (attendue par les composants shadcn et AI Elements). */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
