// The Channel's Hosts (ADR 0015), as the Hosts page and the Start an Agent sheet both read them.

import type { HostsResponse } from "@shared/index";
import { useEffect, useMemo, useState } from "react";
import { useChannel, useStore } from "./store";

/**
 * The Channel's Hosts, read again whenever one comes online or goes offline, an Agent starts
 * or stops on one, or `again` changes (the sheet passes how often it was opened). `undefined`
 * while loading, `null` when the Channel's Worker has no Hosts.
 */
export function useHosts(again?: unknown): { hosts?: HostsResponse | null; problem?: string } {
  const store = useStore();
  const { events, agents } = useChannel();
  const lastHostEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === "host.online" || events[i]!.type === "host.offline") return events[i]!.id;
    return undefined;
  }, [events]);
  const onHosts = agents
    .filter((a) => a.host)
    .map((a) => `${a.id}:${a.presence}`)
    .join(" ");
  const [state, setState] = useState<{ hosts?: HostsResponse | null; problem?: string }>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Host event, the Agents on Hosts and `again` are what make a read stale.
  useEffect(() => {
    let live = true;
    store.source.hosts().then(
      (hosts) => live && setState({ hosts }),
      (e: Error) => live && setState((s) => ({ hosts: s.hosts, problem: e.message })),
    );
    return () => {
      live = false;
    };
  }, [store, lastHostEvent, onHosts, again]);
  return state;
}
