// The artifacts Persons and their Agents share on the mock Channel (ADR 0053): every version
// kept of each, with its page. A report, a chart and a small tool, each a self-contained page
// as an Agent makes one: its own styles and scripts inline, nothing fetched.
import type { ArtifactPublisher, ArtifactSummary } from "@shared/index";
import { artifactSize, htmlTitle } from "@shared/index";
import { A, ago } from "./fixtures";
import { standInDigest } from "./skills";

/** A kept version: its summary and its page. */
export interface MockArtifact extends ArtifactSummary {
  html: string;
}

/** One version as the Channel keeps it, from its page: the title is the page's `<title>` unless one is given. */
export function artifactVersion(
  name: string,
  version: number,
  html: string,
  publishedBy: ArtifactPublisher,
  publishedAt: string,
  title?: string,
  /** The Person who first published the name; the publisher's Person for a first version. */
  owner = publishedBy.person,
): MockArtifact {
  return {
    name,
    title: title ?? htmlTitle(html) ?? name,
    owner,
    version,
    size: artifactSize(html),
    digest: standInDigest(new TextEncoder().encode(html)),
    publishedBy,
    publishedAt,
    html,
  };
}

const PAGE_STYLE = `
  :root { color-scheme: light; --ink: #23211d; --ink-2: #57534b; --rule: #e4e1da; --paper: #fdfcfa; --accent: #2f5d50; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 24px 48px; background: var(--paper); color: var(--ink); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 26px; line-height: 1.2; margin: 0 0 4px; font-weight: 650; letter-spacing: -0.01em; }
  .meta { color: var(--ink-2); margin: 0 0 28px; font-size: 13px; }
  h2 { font-size: 16px; margin: 32px 0 10px; }
  table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { text-align: left; padding: 8px 10px 8px 0; border-bottom: 1px solid var(--rule); }
  th { font-size: 12px; font-weight: 600; color: var(--ink-2); }
  td.n, th.n { text-align: right; }
`;

const latency = (rows: [string, number, number, number][], week: number) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>API latency, week ${week}</title>
<style>${PAGE_STYLE}
  .bar { display: inline-block; height: 6px; background: var(--accent); border-radius: 1px; vertical-align: middle; }
  .slow td { color: #8a2f1f; }
</style>
</head>
<body>
<main>
  <h1>API latency, week ${week}</h1>
  <p class="meta">From the retry branch's load test against staging: 20,000 requests per route, p50 and p99 in milliseconds.</p>
  <table>
    <thead><tr><th>Route</th><th class="n">p50</th><th class="n">p99</th><th class="n">Errors</th><th></th></tr></thead>
    <tbody>
      ${rows
        .map(
          ([route, p50, p99, errors]) =>
            `<tr${p99 > 900 ? ' class="slow"' : ""}><td><code>${route}</code></td><td class="n">${p50}</td><td class="n">${p99}</td><td class="n">${errors}</td><td><span class="bar" style="width:${Math.round(p99 / 12)}px"></span></td></tr>`,
        )
        .join("\n      ")}
    </tbody>
  </table>
  <h2>What changed</h2>
  <p>Retries now back off at 250 ms, 1 s and 4 s, so a 429 storm no longer doubles the p99 of every list route. <code>/users</code> is still slow: it pages by offset.</p>
</main>
</body>
</html>
`;

/** The largest size the chart's scale shows, in KB: every route here is under it. */
const BUNDLE_SCALE_KB = 200;
const BUNDLE_BUDGET_KB = 150;

// Bars in HTML and CSS rather than a scaled SVG, so the labels keep their size at any width.
const bundle = (routes: [string, number][], label: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bundle size by route</title>
<style>${PAGE_STYLE}
  .chart { display: grid; grid-template-columns: max-content 1fr max-content; column-gap: 12px; margin: 0; padding: 0; list-style: none; }
  .chart li { display: grid; grid-column: 1 / -1; grid-template-columns: subgrid; align-items: center; padding: 9px 0; font-size: 13px; }
  .route { color: var(--ink-2); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; overflow-wrap: anywhere; }
  .track { position: relative; height: 16px; }
  .bar { position: absolute; inset: 0 auto 0 0; background: var(--accent); border-radius: 2px; }
  .over .bar { background: #8a2f1f; }
  .budget { position: absolute; top: -9px; bottom: -9px; left: ${(BUNDLE_BUDGET_KB / BUNDLE_SCALE_KB) * 100}%; border-left: 1px dashed #8a2f1f; }
  .value { text-align: right; font-variant-numeric: tabular-nums; }
  .key { display: flex; align-items: center; gap: 8px; margin: 18px 0 0; color: var(--ink-2); font-size: 13px; }
  .key::before { content: ""; width: 0; height: 14px; border-left: 1px dashed #8a2f1f; }
</style>
</head>
<body>
<main>
  <h1>Bundle size by route</h1>
  <p class="meta">${label}. Gzipped kilobytes.</p>
  <ol class="chart" aria-label="Bundle size by route">
    ${routes
      .map(
        ([route, kb]) =>
          `<li${kb > BUNDLE_BUDGET_KB ? ' class="over"' : ""}><span class="route">${route}</span><span class="track"><span class="bar" style="width:${(Math.min(kb, BUNDLE_SCALE_KB) / BUNDLE_SCALE_KB) * 100}%"></span><span class="budget"></span></span><span class="value">${kb} KB</span></li>`,
      )
      .join("\n    ")}
  </ol>
  <p class="key">The ${BUNDLE_BUDGET_KB} KB budget</p>
</main>
</body>
</html>
`;

const SPLITTER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt splitter</title>
<style>${PAGE_STYLE}
  form { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 28px; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--ink-2); }
  input { font: inherit; color: var(--ink); padding: 8px 10px; border: 1px solid #c9c5bc; border-radius: 4px; background: #fff; }
  input:focus { outline: 2px solid var(--ink); outline-offset: 1px; }
  .each { font-size: 44px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; margin: 0; }
</style>
</head>
<body>
<main>
  <h1>Receipt splitter</h1>
  <p class="meta">What each person pays, with the tip.</p>
  <form>
    <label>Total <input id="total" type="number" min="0" step="0.01" value="86.40"></label>
    <label>Tip, percent <input id="tip" type="number" min="0" step="1" value="18"></label>
    <label>People <input id="people" type="number" min="1" step="1" value="4"></label>
  </form>
  <p class="meta">Each pays</p>
  <p class="each" id="each" aria-live="polite"></p>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  function update() {
    const total = Number($("total").value) || 0;
    const tip = Number($("tip").value) || 0;
    const people = Math.max(1, Math.round(Number($("people").value) || 1));
    $("each").textContent = money.format((total * (1 + tip / 100)) / people);
  }
  document.querySelector("form").addEventListener("input", update);
  update();
</script>
</body>
</html>
`;

/** The page maya's users-page Agent publishes while the demo runs, with `artifact_publish`. */
export const PAGER_STATES = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pager states</title>
<style>${PAGE_STYLE}
  .row { display: flex; align-items: center; gap: 6px; padding: 14px 0; border-bottom: 1px solid var(--rule); flex-wrap: wrap; }
  .row b { width: 120px; font-size: 13px; font-weight: 600; color: var(--ink-2); }
  button { font: inherit; font-size: 13px; min-width: 32px; height: 30px; padding: 0 10px; border: 1px solid #c9c5bc; border-radius: 4px; background: #fff; color: var(--ink); }
  button[aria-current] { background: var(--ink); border-color: var(--ink); color: #fff; }
  button:disabled { opacity: 0.45; }
</style>
</head>
<body>
<main>
  <h1>Pager states</h1>
  <p class="meta">Every state of the Pager on the users page, for review before #14 merges.</p>
  <div class="row"><b>First page</b><button disabled>Previous</button><button aria-current="page">1</button><button>2</button><button>3</button><button>Next</button></div>
  <div class="row"><b>Middle</b><button>Previous</button><button>1</button><button aria-current="page">2</button><button>3</button><button>Next</button></div>
  <div class="row"><b>Last page</b><button>Previous</button><button>1</button><button>2</button><button aria-current="page">3</button><button disabled>Next</button></div>
  <div class="row"><b>One page</b><button disabled>Previous</button><button aria-current="page">1</button><button disabled>Next</button></div>
</main>
</body>
</html>
`;

const retry: ArtifactPublisher = { person: "dev", agent: A.devClaude, nickname: "retry" };
const gemini: ArtifactPublisher = { person: "maya", agent: A.mayaGemini };

/** Every version kept, oldest first. */
export const ARTIFACT_VERSIONS: MockArtifact[] = [
  artifactVersion(
    "bundle-size",
    1,
    bundle(
      [
        ["/", 92],
        ["/users", 171],
        ["/settings", 118],
      ],
      "Before the users page was split",
    ),
    gemini,
    ago(86_400 * 2),
  ),
  artifactVersion(
    "bundle-size",
    2,
    bundle(
      [
        ["/", 92],
        ["/users", 139],
        ["/settings", 118],
      ],
      "After the users page was split",
    ),
    gemini,
    ago(86_400),
  ),
  artifactVersion(
    "bundle-size",
    3,
    bundle(
      [
        ["/", 88],
        ["/users", 131],
        ["/settings", 104],
        ["/billing", 146],
      ],
      "With the billing route",
    ),
    gemini,
    ago(60 * 50),
  ),
  artifactVersion(
    "api-latency",
    1,
    latency(
      [
        ["GET /tasks", 41, 380, 0],
        ["GET /users", 96, 1240, 3],
        ["POST /tasks", 58, 610, 1],
      ],
      44,
    ),
    retry,
    ago(86_400 * 6),
  ),
  artifactVersion(
    "api-latency",
    2,
    latency(
      [
        ["GET /tasks", 38, 290, 0],
        ["GET /users", 91, 980, 1],
        ["POST /tasks", 52, 420, 0],
        ["GET /agents", 22, 140, 0],
      ],
      45,
    ),
    retry,
    ago(60 * 12),
  ),
  artifactVersion("receipt-splitter", 1, SPLITTER, { person: "shlok" }, ago(60 * 60 * 3)),
];
