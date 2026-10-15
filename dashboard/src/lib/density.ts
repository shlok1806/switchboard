// Row density (ADR 0023): comfortable rows are 40px, compact rows 32px. The choice is
// saved per browser and set as `data-density` on the root, where tokens.css reads it.

export type Density = "comfortable" | "compact";

const KEY = "switchboard.density";

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
