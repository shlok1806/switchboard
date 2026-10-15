import { useEffect, useState } from "react";

/** Hash routes, so the static build works from any path a Worker serves it on. */
export type Route =
  | { view: "now" }
  | { view: "feed"; event?: string }
  | { view: "tasks" }
  | { view: "task"; number: number }
  | { view: "agents" }
  | { view: "agent"; id: string }
  | { view: "canvas"; agent?: string }
  | { view: "compare"; turn?: string }
  | { view: "memory" }
  | { view: "hosts"; host?: string };

export function parse(hash: string): Route {
  const [, view = "now", arg] = hash.replace(/^#/, "").split("/");
  const a = arg ? decodeURIComponent(arg) : undefined;
  switch (view) {
    case "tasks":
      return a ? { view: "task", number: Number(a) } : { view: "tasks" };
    case "agents":
      return a ? { view: "agent", id: a } : { view: "agents" };
    case "compare":
      return { view: "compare", turn: a };
    case "canvas":
      return { view: "canvas", agent: a };
    case "feed":
      return { view: "feed", event: a };
    case "memory":
      return { view: "memory" };
    case "hosts":
      return { view: "hosts", host: a };
    default:
      return { view: "now" };
  }
}

export function href(route: Route): string {
  switch (route.view) {
    case "now":
      return "#/now";
    case "feed":
      return route.event ? `#/feed/${route.event}` : "#/feed";
    case "tasks":
      return "#/tasks";
    case "task":
      return `#/tasks/${route.number}`;
    case "agents":
      return "#/agents";
    case "agent":
      return `#/agents/${encodeURIComponent(route.id)}`;
    case "canvas":
      return route.agent ? `#/canvas/${encodeURIComponent(route.agent)}` : "#/canvas";
    case "compare":
      return route.turn ? `#/compare/${encodeURIComponent(route.turn)}` : "#/compare";
    case "memory":
      return "#/memory";
    case "hosts":
      return route.host ? `#/hosts/${encodeURIComponent(route.host)}` : "#/hosts";
  }
}

export function go(route: Route) {
  window.location.hash = href(route);
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
