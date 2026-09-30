import { useCallback, useEffect, useState } from "react";

/**
 * The four desktops from shlokthakkar.com. "system" follows the OS: Motif when
 * it is light, Console when it is dark. Every preset is a class on <html> that
 * swaps the tokens in styles/tokens.css; Console also sets `.dark` so the
 * `dark:` variant in vendored components keeps working.
 */
export type Preset = "motif" | "cde" | "tango" | "twm";
export type ThemeChoice = "system" | Preset;

export const PRESETS: { id: Preset; name: string; code: string; dark: boolean }[] = [
  { id: "motif", name: "Motif", code: "OSF/1", dark: false },
  { id: "cde", name: "CDE", code: "1996", dark: false },
  { id: "tango", name: "Console", code: "Tango", dark: true },
  { id: "twm", name: "twm", code: "X11R5", dark: false },
];

const KEY = "switchboard.theme";
const IDS = PRESETS.map((p) => p.id) as string[];

function read(): ThemeChoice {
  // `?theme=` forces a theme for one visit, for screenshots and shared links.
  // `light` and `dark` are kept as aliases for Motif and Console.
  const forced = new URLSearchParams(window.location.search).get("theme");
  if (forced === "light") return "motif";
  if (forced === "dark") return "tango";
  if (forced && IDS.includes(forced)) return forced as Preset;
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light") return "motif";
    if (v === "dark") return "tango";
    if (v === "system" || (v && IDS.includes(v))) return v as ThemeChoice;
  } catch {
    /* storage can be blocked; fall back to system */
  }
  return "system";
}

function resolve(choice: ThemeChoice): Preset {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "tango" : "motif";
}

function paint(choice: ThemeChoice) {
  const root = document.documentElement;
  const preset = resolve(choice);
  root.classList.add("theme-switching");
  for (const id of IDS) root.classList.toggle(id, id === preset);
  root.classList.toggle("dark", PRESETS.find((p) => p.id === preset)!.dark);
  requestAnimationFrame(() => root.classList.remove("theme-switching"));
}

/** Run before React renders, so the first paint is already in the right theme. */
export function initTheme() {
  paint(read());
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read);

  useEffect(() => {
    paint(choice);
    if (choice !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => paint("system");
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [choice]);

  const set = useCallback((c: ThemeChoice) => {
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* not persisted; still applies for this visit */
    }
    setChoice(c);
  }, []);

  const resolved = typeof window === "undefined" ? "motif" : resolve(choice);
  return { choice, resolved, set };
}
