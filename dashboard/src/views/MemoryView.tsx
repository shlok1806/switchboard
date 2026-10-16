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
import { Button, buttonVariants } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { shortName } from "@/components/domain/fleet";
import { EventRow, RowFrame } from "@/components/domain/log";
import { OlderRow } from "@/components/domain/older";
import { InspectorFrame, InspectorMissing, SheetClose } from "@/components/shell/inspector";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { EmptyState, EmptyView, ErrorPage, ViewSkeleton } from "@/components/shell/states";
import { useEventDetail } from "@/data/history";
import type { HistoryScope } from "@/data/source";
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
  const [attempt, setAttempt] = useState(0);
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
  }, [store, q, tag, latest, attempt]);

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

  const searching = q !== "" || tag !== null;
  if (loaded === null) {
    return (
      <EmptyView view="Memory" title="Memory is not on this Channel yet" action={<HowNotesWork />}>
        This Channel's Worker predates memory notes. Agents on it cannot leave notes for each other yet.
      </EmptyView>
    );
  }
  // The first read: nothing is on the page yet, so the whole view waits or fails.
  if (loaded === undefined) {
    return problem ? (
      <ErrorPage
        title="Could not read the notes"
        reason={problem}
        actions={
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        }
      >
        The rest of the Channel is fine. Only the memory notes did not load.
      </ErrorPage>
    ) : (
      <ViewSkeleton view="memory" />
    );
  }
  if (loaded.notes.length === 0 && !searching) {
    return (
      <EmptyView view="Memory" title="No notes yet" action={<HowNotesWork />}>
        An Agent leaves a note with memory_note when it learns something the others should know, and every Agent on the Channel can read it.
      </EmptyView>
    );
  }

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
                // `/` on this list searches here (the palette's shortcut).
                data-slash-find
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
          {notes.length === 0 ? (
            <EmptyState
              title="No note matches"
              action={
                <Button
                  onClick={() => {
                    setFind("");
                    setTag(null);
                  }}
                >
                  Clear the search
                </Button>
              }
            >
              {q ? <>Nothing on the Channel matches “{find.trim()}”{tag ? ` with the tag ${TAG_LABEL[tag]}` : ""}.</> : <>No note has the tag {tag && TAG_LABEL[tag]} yet.</>}
            </EmptyState>
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
      {selected && <NoteInspector id={selected} sheet={mobile} onClose={close} />}
    </div>
  );
}

const ADR_MEMORY = "https://github.com/shlok1806/switchboard/blob/main/docs/adr/0019-agents-share-memory-on-the-channel.md";

/** Links the decision that explains memory notes. */
function HowNotesWork() {
  return (
    <a href={ADR_MEMORY} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
      How notes work
    </a>
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
function NoteInspector({ id, sheet, onClose: close }: { id: string; sheet: boolean; onClose: () => void }) {
  const onClose = sheet ? close : undefined;
  const store = useStore();
  const { events, verdictsByEvent } = useChannel();
  const { event, status } = useEventDetail(id);
  const note = event ? noteFromEvent(event) : null;
  const near = (e: ChannelEvent) =>
    !!note && e.id !== note.id && ((e.actor.kind === "agent" && e.actor.agentId === note.author) || (note.task !== undefined && e.task === note.task));
  const at = note ? events.findIndex((e) => e.id === note.id) : -1;
  // A note older than the Events loaded: its author's and its Task's Events before it are
  // read from the Channel, a page of each.
  const [readBefore, setReadBefore] = useState<{ id: string; events?: ChannelEvent[] }>();
  const older = note !== null && at < 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the note's id, seq, author and Task are what the read asks for.
  useEffect(() => {
    if (!note || !older) return;
    let live = true;
    const scopes: HistoryScope[] = [{ agent: note.author }, ...(note.task !== undefined ? [{ task: note.task }] : [])];
    Promise.all(scopes.map((scope) => store.source.scopedEvents(scope, note.seq))).then(
      (pages) => {
        if (!live) return;
        const byId = new Map<string, ChannelEvent>();
        for (const page of pages) for (const e of page.events) byId.set(e.id, e);
        setReadBefore({ id: note.id, events: [...byId.values()].sort((a, b) => a.seq - b.seq) });
      },
      () => live && setReadBefore({ id: note.id }),
    );
    return () => {
      live = false;
    };
  }, [store, note?.id, note?.seq, note?.author, note?.task, older]);
  const around = (() => {
    if (!note) return { state: "none" as const };
    if (at >= 0) {
      return { state: "loaded" as const, before: events.slice(0, at).filter(near).slice(-AROUND), after: events.slice(at + 1).filter(near).slice(0, AROUND) };
    }
    if (readBefore?.id !== note.id) return { state: "reading" as const };
    if (!readBefore.events) return { state: "failed" as const };
    // What came after an older note is between it and the Events loaded: not shown.
    return { state: "older" as const, before: readBefore.events.filter(near).slice(-AROUND), after: [] };
  })();
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
  if (status === "missing" || (event && !note))
    return (
      <InspectorMissing title="No such note" sheet={sheet} onClose={close}>
        This Channel has no note with that address. It may be from another Channel, or the link was cut short.
      </InspectorMissing>
    );
  if (status === "failed")
    return (
      <InspectorMissing title="Could not read the note" sheet={sheet} onClose={close}>
        The Channel did not answer. The note is still there; open it again in a moment.
      </InspectorMissing>
    );
  return (
    <InspectorFrame label="Note, in the inspector" onClose={onClose}>
      {!event ? (
        <p className="text-small text-ink-3">Reading the note</p>
      ) : !note ? null : (
        <>
          <header className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 text-title font-semibold text-ink">Note</h2>
            <SheetClose onClose={onClose} />
          </header>
          <div className="flex flex-col gap-1.5">
            <NoteBody note={note} />
          </div>
          <Section title="Around it" meta={note.task !== undefined ? `its author's and #${note.task}'s Events` : "its author's Events"} as="h3">
            {around.state === "none" || around.state === "reading" ? (
              <p className="text-small text-ink-3">Reading what came before it</p>
            ) : around.state === "failed" ? (
              <p className="text-small text-ink-3">Could not read what came before it. It is in <a href={href({ view: "agent", id: note.author })} className="text-ink hover:underline">its author's history</a>.</p>
            ) : around.before.length + around.after.length === 0 ? (
              <p className="text-small text-ink-3">Nothing else from its author{note.task !== undefined && " or on its Task"} {around.state === "older" ? "came before it" : "is loaded"}.</p>
            ) : (
              <ol className="border-t border-rule">
                {around.before.map(row)}
                <li className="list-none border-b border-rule px-1 py-2 text-small font-medium text-ink">This note, {clock(note.at)}</li>
                {around.after.map(row)}
                {around.state === "older" && <li className="list-none px-1 py-2 text-small text-ink-3">What came after it is not loaded. It is in <a href={href({ view: "agent", id: note.author })} className="text-ink hover:underline">its author's history</a>.</li>}
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
