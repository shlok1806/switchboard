import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "switchboard.theme";

function read(): ThemeChoice {
  // `?theme=dark` forces a theme for one visit, for screenshots and shared links.
  const forced = new URLSearchParams(window.location.search).get("theme");
  if (forced === "light" || forced === "dark") return forced;
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage can be blocked; fall back to the system */
  }
  return "system";
}

function resolve(choice: ThemeChoice): "light" | "dark" {
  if (choice !== "system") return choice;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function paint(choice: ThemeChoice) {
  const root = document.documentElement;
  root.classList.add("theme-switching");
  root.classList.toggle("dark", resolve(choice) === "dark");
  requestAnimationFrame(() => root.classList.remove("theme-switching"));
}

/** Run before React renders, so the first paint is already in the right theme. */
export function initTheme() {
  paint(read());
}

// One choice for the whole page, so every menu that shows it agrees.
let current: ThemeChoice | null = null;
const listeners = new Set<(c: ThemeChoice) => void>();

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(() => (current ??= read()));
  useEffect(() => {
    listeners.add(setChoice);
    return () => {
      listeners.delete(setChoice);
    };
  }, []);
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
    current = c;
    for (const l of listeners) l(c);
  }, []);
  const resolved = typeof window === "undefined" ? "light" : resolve(choice);
  return { choice, resolved, set };
}
