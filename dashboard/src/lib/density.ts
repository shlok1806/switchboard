// Row density (ADR 0023): comfortable rows are 36px, compact rows 30px with no second line.
// The choice is saved per browser and set as `data-density` on the root, where tokens.css
// reads it; views that drop the second line read it with `useDensity`.

import { useSyncExternalStore } from "react";

export type Density = "comfortable" | "compact";

const KEY = "switchboard.density";
const listeners = new Set<() => void>();

function read(): Density {
  // `?density=compact` forces a density for one visit, for screenshots and shared links.
  const forced = new URLSearchParams(window.location.search).get("density");
  if (forced === "comfortable" || forced === "compact") return forced;
  try {
    if (localStorage.getItem(KEY) === "compact") return "compact";
  } catch {
    /* storage can be blocked; fall back to comfortable */
  }
  return "comfortable";
}

/** Run before React renders, so the first paint has the right row height. */
export function initDensity() {
  document.documentElement.dataset.density = read();
}

/** The density on the root now. */
function current(): Density {
  return document.documentElement.dataset.density === "compact" ? "compact" : "comfortable";
}

/** Sets the density for this browser, and every view reading it. */
export function setDensity(density: Density) {
  document.documentElement.dataset.density = density;
  try {
    localStorage.setItem(KEY, density);
  } catch {
    /* a private window keeps it for this page only */
  }
  for (const l of listeners) l();
}

export function useDensity(): Density {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    current,
  );
}
