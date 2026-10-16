// The Channel's Hosts (ADR 0015), as the Hosts page and the Start an Agent sheet both read them.

import type { HostsResponse } from "@shared/index";
import { useEffect, useMemo, useState } from "react";
import { type ChannelStore, useChannel, useStore } from "./store";

// One read at a time per Channel: views that mount together (the Start an Agent button, the
// sheet, the Hosts page) share it instead of asking the Worker once each. A settled read is
// not reused, so no view shows a list older than its own mount. Each read is tagged with what
// the page had seen when it started (`seen`: the last Host event and the Agents on Hosts); a
// read wanted after something new happened does not take one started before it.
const reading = new WeakMap<ChannelStore, { read: Promise<HostsResponse | null>; seen: string }>();

/** What makes a read of the Hosts stale: the last Host event, and the Agents on Hosts. */
function useHostsSeen(): string {
  const { events, agents } = useChannel();
  const lastHostEvent = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === "host.online" || events[i]!.type === "host.offline") return events[i]!.id;
    return "";
  }, [events]);
  const onHosts = agents
    .filter((a) => a.host)
    .map((a) => `${a.id}:${a.presence}`)
    .join(" ");
  return `${lastHostEvent} ${onHosts}`;
}

/** The Channel's Hosts, sharing a read already under way unless it began before `seen`. */
export function readHosts(store: ChannelStore, seen: string): Promise<HostsResponse | null> {
  const under = reading.get(store);
  if (under?.seen === seen) return under.read;
  const read = store.source.hosts();
  reading.set(store, { read, seen });
  const done = () => {
    if (reading.get(store)?.read === read) reading.delete(store);
  };
  read.then(done, done);
  return read;
}

// Whether a Channel's Worker has Hosts never changes while the page is open: its first answer is kept.
const supported = new WeakMap<ChannelStore, boolean>();

/** Whether this Channel's Worker has Hosts at all (ADR 0015): `null` while asking. */
export function useHostsSupported(): boolean | null {
  const store = useStore();
  const seen = useHostsSeen();
  const [known, setKnown] = useState<boolean | null>(() => supported.get(store) ?? null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the answer never changes once known; `seen` only lets the first read share.
  useEffect(() => {
    if (supported.has(store)) return setKnown(supported.get(store)!);
    let live = true;
    // A failed read is not an answer: the next button or view that mounts asks again.
    readHosts(store, seen).then(
      (r) => {
        supported.set(store, r !== null);
        if (live) setKnown(r !== null);
      },
      () => live && setKnown(false),
    );
    return () => {
      live = false;
    };
  }, [store]);
  return known;
}

/**
 * The Channel's Hosts, read again whenever one comes online or goes offline, an Agent starts
 * or stops on one, or `again` changes (the sheet passes how often it was opened). `undefined`
 * while loading, `null` when the Channel's Worker has no Hosts.
 */
export function useHosts(again?: unknown): { hosts?: HostsResponse | null; problem?: string } {
  const store = useStore();
  const seen = useHostsSeen();
  const [state, setState] = useState<{ hosts?: HostsResponse | null; problem?: string }>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Host event, the Agents on Hosts and `again` are what make a read stale.
  useEffect(() => {
    let live = true;
    readHosts(store, seen).then(
      (hosts) => {
        supported.set(store, hosts !== null);
        if (live) setState({ hosts });
      },
      (e: Error) => live && setState((s) => ({ hosts: s.hosts, problem: e.message })),
    );
    return () => {
      live = false;
    };
  }, [store, seen, again]);
  return state;
}
