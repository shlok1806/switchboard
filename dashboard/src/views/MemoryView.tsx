/*
 * The Memory view: the notes Agents leave for each other (ADR 0019), newest first, or the
 * best matches for a search. Each note is its text at reading width, then who left it, on
 * which Task, about which files and when. Tags narrow the list; older notes load a page at
 * a time, except for a search, whose best matches the Worker ranks and does not page. A new
 * note reloads the first page. A note opens in the inspector (#/memory/<note>), or on a phone
 * in a sheet, with the Events around it: its author's and its Task's, just before and after.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChannelEvent, MemoryNote, MemoryTag } from "@shared/index";
import { MEMORY_TAGS, noteFromEvent } from "@shared/index";
import { Chip } from "@/components/atoms/Chip";
import { shortName } from "@/components/domain/fleet";
import { EventRow, RowFrame } from "@/components/domain/log";
import { OlderRow } from "@/components/domain/older";
import { Pending } from "@/components/domain/pending";
import { InspectorFrame, SheetClose } from "@/components/shell/inspector";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { useEventDetail } from "@/data/history";
import { useChannel, useIndex, useStore } from "@/data/store";
import { TAG_LABEL, ago, clock } from "@/lib/format";
import { useIsMobile } from "@/hooks/use-mobile";
import { go, href } from "@/lib/router";

const PAGE = 30;

interface Loaded {
  notes: MemoryNote[];
  more: boolean;
}

export function MemoryView({ selected }: { selected?: string }) {
  const store = useStore();
  const { events } = useChannel();
  const mobile = useIsMobile();
  const [tag, setTag] = useState<MemoryTag | null>(null);
  const [find, setFind] = useState("");
  const q = searchable(useSettled(find, 250));
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(undefined);
  const [problem, setProblem] = useState<string>();
  const [older, setOlder] = useState(false);
  // The newest note on the Channel: when it changes, the first page is read again.
  const latest = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === "memory.note") return events[i]!.seq;
    return undefined;
  }, [events]);
  const asked = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new note is what makes the first page stale.
  useEffect(() => {
    const ask = ++asked.current;
    store.source.memory({ q: q || undefined, tag: tag ?? undefined, limit: PAGE }).then(
      (r) => {
        if (ask !== asked.current) return;
        setProblem(undefined);
        setLoaded(r && { notes: r.notes, more: r.more === true });
      },
      (e: Error) => ask === asked.current && setProblem(e.message),
    );
  }, [store, q, tag, latest]);

  const loadOlder = () => {
    const last = loaded?.notes.at(-1);
    // A search is ranked, not ordered by seq: paging it by seq would skip and repeat notes.
    if (!loaded || !last || q) return;
    const ask = asked.current;
    setOlder(true);
    store.source
      .memory({ q: q || undefined, tag: tag ?? undefined, before: last.seq, limit: PAGE })
      .then(
        (r) => {
          if (ask !== asked.current || !r) return;
          setLoaded((l) => l && { notes: [...l.notes, ...r.notes], more: r.more === true });
        },
        (e: Error) => setProblem(e.message),
      )
      .finally(() => setOlder(false));
  };

  if (loaded === null) {
    return (
      <Pending title="Memory is not on this Channel yet" className="h-full">
        This Channel's Worker predates memory notes. Agents on it cannot leave notes for each other yet.
      </Pending>
    );
  }

  const searching = q !== "" || tag !== null;
  const notes = loaded?.notes ?? [];
  const pick = (id: string) => go({ view: "memory", note: id });
  const close = () => go({ view: "memory" });

  return (
    <div className="flex h-full min-h-0">
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full max-w-[60rem] flex-col gap-5 px-[var(--gutter)] pt-5 pb-12">
        <PageHead
          title="Memory"
          facts={[
            loaded && `${notes.length}${loaded.more ? "+" : ""} ${notes.length === 1 && !loaded.more ? "note" : "notes"}${searching ? " match" : ""}`,
            q ? "best match first" : "newest first",
            "Agents leave them with memory_note",
          ]}
        />
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
          <div role="group" aria-label="Tag" className="flex flex-wrap gap-1.5">
            <Chip on={tag === null} onClick={() => setTag(null)}>
              All
            </Chip>
            {MEMORY_TAGS.map((t) => (
              <Chip key={t} on={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                {TAG_LABEL[t]}
              </Chip>
            ))}
          </div>
          <label className="ml-auto flex flex-col gap-1 text-small text-ink-3 max-sm:ml-0 max-sm:w-full">
            Find
            <input
              type="search"
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder="retries client.ts"
              className="h-[30px] w-60 min-w-0 rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-3 hover:bg-paper-2 max-sm:w-full max-sm:text-[16px]"
            />
          </label>
        </div>

        {problem && (
          <p role="alert" className="text-small text-ink-2">
            Could not read the notes: {problem}
          </p>
        )}
        {loaded === undefined ? (
          !problem && <p className="border-t border-rule py-6 text-row text-ink-3">Reading the notes</p>
        ) : notes.length === 0 ? (
          <p className="border-t border-rule py-6 text-row text-ink-3">
            {searching ? "No note matches." : "No notes yet. An Agent leaves one with memory_note when it learns something the others should know."}
          </p>
        ) : (
          <ol className="border-t border-rule" aria-label="Notes">
            {notes.map((n) => (
              <Note key={n.id} note={n} selected={n.id === selected} onPick={() => pick(n.id)} />
            ))}
            {loaded.more &&
              (q ? (
                // The Worker ranks a search's matches, so there is no older page of them to ask for.
                <li className="py-3 text-small text-ink-3">
                  The best {notes.length} matches. Narrow the search for more.
                </li>
              ) : (
                <OlderRow loading={older} onClick={loadOlder} what="notes" />
              ))}
          </ol>
        )}
      </div>
    </div>
      {selected && <NoteInspector id={selected} onClose={mobile ? close : undefined} />}
    </div>
  );
}

/** One note as a row: its text, the files it names, then its tags, author, Task and age. */
export function Note({ note: n, selected, onPick }: { note: MemoryNote; selected: boolean; onPick: () => void }) {
  return (
    <RowFrame selected={selected} onPick={onPick} className="flex flex-col gap-1.5 px-2 py-3.5">
      <NoteBody note={n} />
    </RowFrame>
  );
}

/** A note's text, files and the line under them. */
function NoteBody({ note: n }: { note: MemoryNote }) {
  const { agentById, taskByNumber } = useIndex();
  const author = agentById.get(n.author);
  const task = n.task !== undefined ? taskByNumber.get(n.task) : undefined;
  return (
    <>
      <p className="max-w-[72ch] text-row break-words whitespace-pre-line text-ink">{n.text}</p>
      {n.files && n.files.length > 0 && (
        <ul aria-label="Files" className="flex flex-wrap gap-x-3 gap-y-0.5">
          {n.files.map((f) => (
            <li key={f}>
              <code className="text-small [overflow-wrap:anywhere] text-ink-2">{f}</code>
            </li>
          ))}
        </ul>
      )}
      <p className="text-small text-ink-3">
        <span className="font-semibold text-ink-2">{n.tags.map((t) => TAG_LABEL[t]).join(", ")}</span>
        {" · "}
        {author ? (
          <a href={href({ view: "agent", id: author.id })} className="text-ink hover:underline">
            {n.person}/{shortName(author)}
          </a>
        ) : (
          <span>{n.nickname ? `${n.person}/${n.nickname}` : n.author}</span>
        )}
        {n.task !== undefined && (
          <>
            {" on "}
            <a href={href({ view: "task", number: n.task })} className="text-ink hover:underline">
              #{n.task}
              {task && ` ${task.title}`}
            </a>
          </>
        )}
        {" · "}
        <time dateTime={n.at} title={clock(n.at)}>
          {ago(n.at)}
        </time>
      </p>
    </>
  );
}

// How many of the author's and the Task's Events to show on each side of a note.
const AROUND = 4;

/** A note in the inspector, with the Events around it. */
function NoteInspector({ id, onClose }: { id: string; onClose?: () => void }) {
  const { events, verdictsByEvent } = useChannel();
  const { event } = useEventDetail(id);
  const note = event ? noteFromEvent(event) : null;
  const around = useMemo(() => {
    if (!note) return { before: [], after: [], loaded: false };
    const i = events.findIndex((e) => e.id === note.id);
    if (i < 0) return { before: [], after: [], loaded: false };
    const near = (e: ChannelEvent) =>
      e.id !== note.id && ((e.actor.kind === "agent" && e.actor.agentId === note.author) || (note.task !== undefined && e.task === note.task));
    const before = events.slice(0, i).filter(near).slice(-AROUND);
    const after = events.slice(i + 1).filter(near).slice(0, AROUND);
    return { before, after, loaded: true };
  }, [events, note]);
  const row = (e: ChannelEvent) => (
    <EventRow
      key={e.id}
      event={e}
      verdicts={verdictsByEvent.get(e.id) ?? []}
      selected={false}
      fresh={false}
      onPick={() => go({ view: "feed", event: e.id })}
      // The inspector is narrow: its rows take the two-line shape.
      mobile
    />
  );
  return (
    <InspectorFrame label="Note, in the inspector" onClose={onClose}>
      {!event ? (
        <p className="text-small text-ink-3">Reading the note</p>
      ) : !note ? (
        <p className="text-small text-ink-3">That Event is not a note.</p>
      ) : (
        <>
          <header className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 text-title font-semibold text-ink">Note</h2>
            <SheetClose onClose={onClose} />
          </header>
          <div className="flex flex-col gap-1.5">
            <NoteBody note={note} />
          </div>
          <Section title="Around it" meta={note.task !== undefined ? `its author's and #${note.task}'s Events` : "its author's Events"} as="h3">
            {!around.loaded ? (
              <p className="text-small text-ink-3">This note is older than the Events loaded, so what came around it is not shown.</p>
            ) : around.before.length + around.after.length === 0 ? (
              <p className="text-small text-ink-3">Nothing else from its author{note.task !== undefined && " or on its Task"} is loaded.</p>
            ) : (
              <ol className="border-t border-rule">
                {around.before.map(row)}
                <li className="list-none border-b border-rule px-1 py-2 text-small font-medium text-ink">This note, {clock(note.at)}</li>
                {around.after.map(row)}
              </ol>
            )}
          </Section>
        </>
      )}
    </InspectorFrame>
  );
}

/**
 * A search the Worker can run: its words are runs of letters, digits and underscores, and a
 * search with none is refused. Anything else is no search at all.
 */
export function searchable(find: string): string {
  const q = find.trim();
  return /[\p{L}\p{N}_]/u.test(q) ? q : "";
}

/** `value` once it has stopped changing for `ms`: a search asked once per pause, not per key. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}
