/*
 * The Memory view: the notes Agents leave for each other (ADR 0019), newest first, or the
 * best matches for a search. Each note is its text at reading width, then who left it, on
 * which Task, about which files and when. Tags narrow the list; older notes load a page at
 * a time, except for a search, whose best matches the Worker ranks and does not page. A new
 * note reloads the first page.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { MemoryNote, MemoryTag } from "@shared/index";
import { MEMORY_TAGS } from "@shared/index";
import { Chip } from "@/components/atoms/Chip";
import { shortName } from "@/components/domain/fleet";
import { OlderRow } from "@/components/domain/older";
import { Pending } from "@/components/domain/pending";
import { PageHead } from "@/components/shell/page-head";
import { useChannel, useIndex, useStore } from "@/data/store";
import { TAG_LABEL, ago, clock } from "@/lib/format";
import { href } from "@/lib/router";

const PAGE = 30;

interface Loaded {
  notes: MemoryNote[];
  more: boolean;
}

export function MemoryView() {
  const store = useStore();
  const { events } = useChannel();
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

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
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
              className="h-[30px] w-60 min-w-0 rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-4 hover:bg-paper-2 max-sm:w-full max-sm:text-[16px]"
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
              <Note key={n.id} note={n} />
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
  );
}

/** One note: its text, the files it names, then its tags, author, Task and age. */
export function Note({ note: n }: { note: MemoryNote }) {
  const { agentById, taskByNumber } = useIndex();
  const author = agentById.get(n.author);
  const task = n.task !== undefined ? taskByNumber.get(n.task) : undefined;
  return (
    <li className="flex flex-col gap-1.5 border-b border-rule py-3.5">
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
    </li>
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
