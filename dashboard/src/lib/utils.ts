import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * tailwind-merge must know the type steps in tokens.css (ADR 0023) are font sizes.
 * Without this it reads `text-small` as a colour, and a later size class silently
 * drops the button's own text colour (`bg-ink text-page` + `text-small` lost `text-page`).
 */
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["label", "small", "row", "body", "lead", "title", "head", "figure", "display"] } },
});

/** Merge class names, letting later Tailwind classes win over conflicting earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
