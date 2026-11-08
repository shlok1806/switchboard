import { useEffect, useState } from "react";

/** Hash routes, so the static build works from any path a Worker serves it on. */
export type Route =
  | { view: "now" }
  /** Activity: one Event in the inspector, or the log grouped by turn with one turn open. */
  | { view: "feed"; event?: string; by?: "turn"; turn?: string }
  | { view: "tasks" }
  | { view: "task"; number: number }
  /** The Agents table, with one Agent selected into the inspector (on a phone, its sheet). */
  | { view: "agents"; selected?: string }
  /** An Agent's page; `focus` opens it with the Directive field focused. */
  | { view: "agent"; id: string; focus?: "directive" }
  | { view: "canvas"; agent?: string }
  | { view: "memory"; note?: string }
  /** The Brief (ADR 0042), at one of its pages: the overview when none is named. */
  | { view: "brief"; page?: string }
  /** The skills Persons share (ADR 0039), one open in the inspector at a version. */
  | { view: "skills"; name?: string; version?: number }
  /** The artifacts shared on the Channel (ADR 0053): the folder of them. */
  | { view: "artifacts" }
  /** One artifact's page in the Dashboard's small browser, at a version: the latest when none is named. */
  | { view: "artifact"; name: string; version?: number }
  | { view: "hosts"; host?: string }
  /** The Channel's settings: its Langfuse project, which only its owner changes (ADR 0044). */
  | { view: "settings" }
  /** An address that is no page of the Dashboard: the error page says so. */
  | { view: "missing"; path: string };

export function parse(hash: string): Route {
  const path = hash.replace(/^#/, "");
  const [, view = "now", arg, arg2, arg3] = path.split("/");
  const a = arg ? decodeURIComponent(arg) : undefined;
  const b = arg2 ? decodeURIComponent(arg2) : undefined;
  const c = arg3 ? decodeURIComponent(arg3) : undefined;
  switch (view) {
    case "tasks":
      if (!a) return { view: "tasks" };
      return /^[1-9]\d*$/.test(a) ? { view: "task", number: Number(a) } : { view: "missing", path };
    case "agents":
      // #/agents/select/<id> selects a row; no Agent ID is "select" (they are person/cli/hex).
      if (a === "select") return b ? { view: "agents", selected: b } : { view: "agents" };
      if (a && b === "directive") return { view: "agent", id: a, focus: "directive" };
      return a ? { view: "agent", id: a } : { view: "agents" };
    // Compare is the log grouped by turn now (slice 9); its old links open there.
    case "compare":
      return { view: "feed", by: "turn", turn: a };
    case "canvas":
      return { view: "canvas", agent: a };
    case "feed":
      // #/feed/turn/<turn>/<event>: an Event picked inside an open turn keeps the turn.
      if (a === "turn") return c ? { view: "feed", by: "turn", turn: b, event: c } : { view: "feed", by: "turn", turn: b };
      return { view: "feed", event: a };
    case "memory":
      return a ? { view: "memory", note: a } : { view: "memory" };
    case "brief":
      return a ? { view: "brief", page: a } : { view: "brief" };
    case "skills":
      if (!a) return { view: "skills" };
      if (b === undefined) return { view: "skills", name: a };
      return /^[1-9]\d*$/.test(b) ? { view: "skills", name: a, version: Number(b) } : { view: "missing", path };
    case "artifacts":
      if (!a) return { view: "artifacts" };
      if (b === undefined) return { view: "artifact", name: a };
      return /^[1-9]\d*$/.test(b) ? { view: "artifact", name: a, version: Number(b) } : { view: "missing", path };
    case "hosts":
      return { view: "hosts", host: a };
    case "settings":
      return a ? { view: "missing", path } : { view: "settings" };
    case "now":
    case "":
      return { view: "now" };
    default:
      return { view: "missing", path };
  }
}

export function href(route: Route): string {
  switch (route.view) {
    case "now":
      return "#/now";
    case "feed":
      if (route.by === "turn") {
        if (!route.turn) return "#/feed/turn";
        const t = `#/feed/turn/${encodeURIComponent(route.turn)}`;
        return route.event ? `${t}/${encodeURIComponent(route.event)}` : t;
      }
      return route.event ? `#/feed/${route.event}` : "#/feed";
    case "tasks":
      return "#/tasks";
    case "task":
      return `#/tasks/${route.number}`;
    case "agents":
      return route.selected ? `#/agents/select/${encodeURIComponent(route.selected)}` : "#/agents";
    case "agent":
      return `#/agents/${encodeURIComponent(route.id)}${route.focus ? `/${route.focus}` : ""}`;
    case "canvas":
      return route.agent ? `#/canvas/${encodeURIComponent(route.agent)}` : "#/canvas";
    case "memory":
      return route.note ? `#/memory/${encodeURIComponent(route.note)}` : "#/memory";
    case "brief":
      return route.page ? `#/brief/${encodeURIComponent(route.page)}` : "#/brief";
    case "skills":
      if (!route.name) return "#/skills";
      return `#/skills/${encodeURIComponent(route.name)}${route.version === undefined ? "" : `/${route.version}`}`;
    case "artifacts":
      return "#/artifacts";
    case "artifact":
      return `#/artifacts/${encodeURIComponent(route.name)}${route.version === undefined ? "" : `/${route.version}`}`;
    case "hosts":
      return route.host ? `#/hosts/${encodeURIComponent(route.host)}` : "#/hosts";
    case "settings":
      return "#/settings";
    case "missing":
      return `#${route.path}`;
  }
}

export function go(route: Route) {
  window.location.hash = href(route);
}

/** Corrects the address without a new history entry: Back skips the address it replaces. */
export function replace(route: Route) {
  history.replaceState(history.state, "", href(route));
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
