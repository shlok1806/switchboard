import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/*
 * tailwind-merge must know the type steps in tokens.css (ADR 0049) are font sizes, and the faces are families.
 * Without this it reads `text-small` as a colour, and a later size class silently
 * drops the button's own text colour (`bg-ink text-paper` + `text-small` lost `text-paper`).
 */
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["label", "small", "row", "title", "read", "section", "head", "head-phone", "figure"], font: ["display", "sans", "mono"] } },
});

/** Merge class names, letting later Tailwind classes win over conflicting earlier ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
