// The screenshot tests (design.md, States): every view in each state it can be in, ready,
// loading, empty and error (and a failed read where a view has one). A ready view is drawn in
// light and dark at 1440 and 390 pixels wide; the other states, whose check is the marker,
// once in light at 1440 and once in dark at 390. Each page is drawn by the built Dashboard over
// the simulated Channel (`?mock=1&state=`, which also stops its clock and timed Events, so two
// runs draw the same pictures) in headless Chrome, and must show the state asked for: the
// marker `data-view-state` the state components set, or a drawn view with none. A phone picture
// must also not scroll sideways anywhere but the terminal's screen (plan slice 12). A failed
// check fails the run. The pictures land in dashboard/screenshots/ (not committed), to look at.
//
//   npm run build && npm run shots
//
// CHROME names the browser when it is not at a usual place. SHOTS_ONLY=agents,tasks narrows
// the views.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "screenshots");

const VIEWS = ["now", "agents", "tasks", "canvas", "feed", "memory", "hosts"];
// Pages that show one thing: ready, loading, and an error page. With nothing on the Channel
// they have nothing to name, which is the error page too.
const PAGES = { agent: "agents/shlok%2Fclaude%2F7f3a", task: "tasks/12" };
const STATES = ["ready", "loading", "empty", "error"];
const DESK = [1440, 900];
const PHONE = [390, 844];
/** The theme and size each picture of a state is taken at. */
const SHOTS = {
  ready: [
    ["light", DESK],
    ["dark", DESK],
    ["light", PHONE],
    ["dark", PHONE],
  ],
  other: [
    ["light", DESK],
    ["dark", PHONE],
  ],
};

const only = process.env.SHOTS_ONLY?.split(",");

/** What `data-view-state` must say: none for a ready view. */
function expected(page, state) {
  if (state === "ready") return null;
  if (page in PAGES && state === "empty") return "error";
  return state;
}

function cases() {
  const list = [];
  for (const state of STATES) {
    for (const view of VIEWS) list.push({ page: view, hash: view, state });
    for (const [page, hash] of Object.entries(PAGES)) list.push({ page, hash, state });
  }
  list.push({ page: "missing", hash: "no-such-page", state: "ready", want: "error" });
  // The views with a read of their own, failing while the Channel is up.
  for (const view of ["hosts", "memory"]) list.push({ page: view, hash: view, state: "read-error", want: "error" });
  return list.filter((c) => !only || only.includes(c.page));
}

function chromePath() {
  if (process.env.CHROME) return process.env.CHROME;
  const known = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = known.find((p) => existsSync(p));
  if (!found) throw new Error("No Chrome found. Set CHROME to its path.");
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, what, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return r;
    } catch {
      // not up yet
    }
    await sleep(100);
  }
  throw new Error(`${what} did not answer at ${url}`);
}

/** One CDP connection to a page target. */
async function connect(port) {
  const targets = await (await waitFor(`http://127.0.0.1:${port}/json`, "Chrome")).json();
  const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      pending.set(++id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.value;
  return { send, evaluate, close: () => ws.close() };
}

// What the page shows: its state marker, and whether a ready view is drawn: its fonts are in,
// it has its title, nothing in it is busy, and it holds content of its own (rows, cards,
// sections or a terminal), not just a head.
const PROBE = `(() => {
  const marked = document.querySelector("[data-view-state]");
  const main = document.querySelector("main");
  const drawn =
    !!main &&
    document.fonts.status === "loaded" &&
    !!main.querySelector("h1") &&
    !main.querySelector("[aria-busy=true]") &&
    main.querySelectorAll("li, tr, [role=row], article, section, canvas, .xterm").length > 0;
  return { state: marked ? marked.getAttribute("data-view-state") : null, drawn };
})()`;

// What scrolls sideways on the page: the page itself, or any box whose content is wider than it
// and that scrolls, except the terminal's screen, which keeps its columns.
const SIDEWAYS = `(() => {
  const found = [];
  const page = document.scrollingElement;
  if (page.scrollWidth > page.clientWidth + 1) found.push("the page");
  for (const el of document.querySelectorAll("body *")) {
    if (el.matches("pre[aria-label=Screen]")) continue;
    const x = getComputedStyle(el).overflowX;
    if ((x === "auto" || x === "scroll") && el.scrollWidth > el.clientWidth + 1) {
      found.push(el.tagName.toLowerCase() + (el.getAttribute("aria-label") ? "[" + el.getAttribute("aria-label") + "]" : "." + String(el.className).split(" ")[0]));
    }
  }
  return found;
})()`;

async function main() {
  const previewPort = await freePort();
  const preview = spawn("npx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort"], { cwd: root, stdio: "ignore" });
  const debugPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), "shots-"));
  const chrome = spawn(
    chromePath(),
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-sandbox", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" },
  );
  // On any way out the browser and the server go; the profile goes once Chrome has let go of it.
  process.on("exit", () => {
    chrome.kill();
    preview.kill();
  });
  const stop = async () => {
    const gone = new Promise((r) => chrome.once("exit", r));
    chrome.kill();
    preview.kill();
    await gone;
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  const base = `http://127.0.0.1:${previewPort}/`;
  let page;
  try {
    await waitFor(base, "vite preview", 300);
    page = await connect(debugPort);
  } catch (e) {
    await stop();
    throw e;
  }
  await page.send("Page.enable");
  // Reduced motion stills the skeleton's pulse and every transition, so a picture never
  // catches one mid-move.
  await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  mkdirSync(out, { recursive: true });

  const failures = [];
  let count = 0;
  for (const c of cases()) {
    const want = c.want ?? expected(c.page, c.state);
    for (const [theme, [w, h]] of c.state === "ready" && c.want === undefined ? SHOTS.ready : SHOTS.other) {
      const name = `${c.state}-${c.page}-${theme}-${w}`;
      await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 640 });
      const state = `&state=${c.state}`;
      // A blank page between cases, so one case's page never answers for the next.
      await page.send("Page.navigate", { url: "about:blank" });
      await page.send("Page.navigate", { url: `${base}?mock=1&theme=${theme}${state}#/${c.hash}` });
      // Wait until the page shows the state asked for: a loading view keeps its skeleton, the
      // others settle on their marker, or a drawn view with none.
      let seen;
      for (let i = 0; i < 80; i++) {
        seen = await page.evaluate(PROBE);
        if (seen?.state === want && (want !== null || seen.drawn)) break;
        await sleep(100);
      }
      // Let fonts and late rows land before the picture.
      await sleep(400);
      seen = await page.evaluate(PROBE);
      const { data } = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(out, `${name}.png`), Buffer.from(data, "base64"));
      count++;
      if (seen?.state !== want || (want === null && !seen.drawn)) {
        failures.push(`${name}: wanted ${want ?? "a ready view"}, saw ${seen?.state ?? (seen?.drawn ? "a ready view" : "nothing drawn")}`);
      }
      if (w < 640) {
        const sideways = await page.evaluate(SIDEWAYS);
        if (sideways.length) failures.push(`${name}: scrolls sideways: ${sideways.join(", ")}`);
      }
    }
  }
  page.close();
  await stop();
  console.log(`${count} screenshots in ${out}`);
  if (failures.length) {
    console.error(`${failures.length} did not show the state asked for:\n  ${failures.join("\n  ")}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
