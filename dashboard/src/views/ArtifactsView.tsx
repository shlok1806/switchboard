/*
 * Artifacts (ADR 0053): the HTML pages Persons and their Agents share on the Channel, such as a
 * report, a chart or a small tool an Agent made. `#/artifacts` is the folder: each artifact at
 * its latest version, the latest published first, and Open HTML file, which publishes a page
 * from this machine as the Person signed in. `#/artifacts/<name>[/<version>]` is the small
 * browser: the page in a frame that fills the view, its versions, Reload, Open in new tab and
 * Download, and Delete for the Person who first published it, asked in place. The page is served in a `sandbox` CSP and framed with the same sandbox, so it runs
 * in an opaque origin: it can never read the Channel, act as its viewer or move the Dashboard.
 * An Agent's `artifact_publish` streams in as its `tool.call`, and both pages read again then.
 */

import type { ArtifactResponse, ArtifactSummary, ArtifactsResponse, StreamMessage } from "@shared/index";
import { ARTIFACT_SANDBOX, artifactNameFrom, checkArtifact, describeSize } from "@shared/index";
import { Download, ExternalLink, FileUp, RotateCw, Trash2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { Segmented } from "@/components/atoms/Segmented";
import { RowFrame } from "@/components/domain/log";
import { Publisher } from "@/components/domain/publisher";
import { PageHead } from "@/components/shell/page-head";
import { EmptyState, EmptyView, ErrorPage, ViewSkeleton } from "@/components/shell/states";
import { type ChannelStore, useStore } from "@/data/store";
import { ago, clock } from "@/lib/format";
import { go, href } from "@/lib/router";
import { cn } from "@/lib/utils";

/** An Agent's `artifact_publish`, done: its Tool Capture names the tool bare, a hook names it as an MCP tool. */
export function isArtifactPublish(m: StreamMessage): boolean {
  if (m.type !== "event" || m.event.type !== "tool.call") return false;
  const { tool, ok } = m.event.payload;
  return ok && (tool === "artifact_publish" || tool.endsWith("__artifact_publish"));
}

/** Calls `onPublish` each time an Agent's publish streams in. */
function useArtifactPublishes(store: ChannelStore, onPublish: () => void) {
  const latest = useRef(onPublish);
  latest.current = onPublish;
  useEffect(() => store.onMessage((m) => isArtifactPublish(m) && latest.current()), [store]);
}

/** The folder: every artifact by its latest version, and Open HTML file. */
export function ArtifactsView() {
  const store = useStore();
  const [loaded, setLoaded] = useState<ArtifactsResponse | null | undefined>(undefined);
  const [problem, setProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  // The versions read before the latest read, so a page published since then is marked as new.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useArtifactPublishes(store, () => setAttempt((n) => n + 1));

  useEffect(() => {
    let live = true;
    store.source.artifacts().then(
      (r) => {
        if (!live) return;
        setProblem(undefined);
        setLoaded(r);
        const now = new Set((r?.artifacts ?? []).map(versionKey));
        if (seen.current) {
          const before = seen.current;
          setFresh(new Set([...now].filter((k) => !before.has(k))));
        }
        seen.current = now;
      },
      (e: Error) => live && setProblem(e.message),
    );
    return () => {
      live = false;
    };
  }, [store, attempt]);

  const open = useOpenHtmlFile();

  if (loaded === null) {
    return (
      <EmptyView view="Artifacts" title="Artifacts are not on this Channel yet" action={<HowArtifactsWork />}>
        This Channel's Worker predates artifacts. Persons and their Agents cannot share HTML pages through it yet.
      </EmptyView>
    );
  }
  if (loaded === undefined) {
    return problem ? (
      <ErrorPage
        title="Could not read the artifacts"
        reason={problem}
        actions={
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        }
      >
        The rest of the Channel is fine. Only the shared artifacts did not load.
      </ErrorPage>
    ) : (
      <ViewSkeleton view="artifacts" />
    );
  }

  const { artifacts } = loaded;
  if (artifacts.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-[var(--gutter)] pt-[var(--page-top)] pb-12">
        <PageHead title="Artifacts" />
        <EmptyState title="No artifacts shared yet" action={open.button}>
          An Agent shares an HTML page it made with <code className="font-mono text-[0.875em]">artifact_publish</code>, and a Person with{" "}
          <code className="font-mono text-[0.875em] [overflow-wrap:anywhere]">switchboard artifacts publish page.html</code> or by opening a file here. Every
          Person on the Channel can then open it in the Dashboard.
        </EmptyState>
        {open.problem}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full max-w-[60rem] flex-col gap-5 px-[var(--gutter)] pt-[var(--page-top)] pb-12">
        <PageHead
          title="Artifacts"
          facts={[`${artifacts.length} ${artifacts.length === 1 ? "page" : "pages"}`, "the latest published first", "each runs in a sandbox"]}
          actions={open.button}
        />
        {open.problem}
        <ol className="border-t border-rule" aria-label="Artifacts">
          {artifacts.map((a) => (
            <RowFrame
              key={a.name}
              selected={false}
              fresh={fresh.has(versionKey(a))}
              onPick={() => go({ view: "artifact", name: a.name })}
              className="flex flex-col gap-1 px-2 py-3.5"
            >
              <p className="flex flex-wrap items-baseline gap-x-2 text-row">
                <span className="font-semibold [overflow-wrap:anywhere] text-ink">{a.title}</span>
                <span className="text-small text-ink-3 tabular-nums">v{a.version}</span>
              </p>
              <p className="text-small [overflow-wrap:anywhere] text-ink-3">
                <Facts artifact={a} />
              </p>
            </RowFrame>
          ))}
        </ol>
      </div>
    </div>
  );
}

const versionKey = (a: ArtifactSummary) => `${a.name}@${a.version}`;

/** A version's name, size, publisher and age, joined by middle dots. */
function Facts({ artifact: a, version = false }: { artifact: ArtifactSummary; version?: boolean }) {
  return (
    <>
      {a.name}
      {version && <span className="tabular-nums"> · v{a.version}</span>}
      {" · "}
      {describeSize(a.size)}
      {" · "}
      <Publisher by={a.publishedBy} />
      {" · "}
      <time dateTime={a.publishedAt} title={clock(a.publishedAt)}>
        {ago(a.publishedAt)}
      </time>
    </>
  );
}

const ADR_ARTIFACTS = "https://github.com/shlok1806/switchboard/blob/main/docs/adr/0053-artifacts-html-pages-shown-in-a-sandbox.md";

/** Links the decision that explains artifacts. */
function HowArtifactsWork() {
  return (
    <a href={ADR_ARTIFACTS} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
      How artifacts work
    </a>
  );
}

/**
 * Open HTML file: publishes a page from this machine as the Person signed in, named after
 * the file, then opens it. The page is checked here first, by the check the Channel runs
 * again, so a page that holds a secret never leaves the machine; the reason shows under it.
 */
function useOpenHtmlFile() {
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const publish = async (file: File) => {
    setProblem(undefined);
    const name = artifactNameFrom(file.name);
    let html: string;
    try {
      html = await file.text();
    } catch (e) {
      setProblem(`Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const check = checkArtifact(name, { html });
    if (!check.ok) {
      setProblem(check.reason);
      return;
    }
    setBusy(true);
    const result = await store.source.publishArtifact(name, { html });
    setBusy(false);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    const { artifact, published } = result.answer;
    if (!published) toast(`${artifact.name} is unchanged`, { description: `v${artifact.version} already holds this page.` });
    go({ view: "artifact", name: artifact.name });
  };

  const button = (
    <>
      <input
        ref={input}
        type="file"
        accept=".html,.htm,text/html"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void publish(file);
        }}
      />
      <Button variant="primary" busy={busy} onClick={() => input.current?.click()}>
        <FileUp className="size-3.5 shrink-0 max-sm:hidden" aria-hidden />
        Open HTML file
      </Button>
    </>
  );
  const shown = problem ? (
    <p role="alert" className="flex max-w-[var(--measure)] items-start gap-1.5 text-small text-ink">
      <TriangleAlert className="mt-[3px] size-3.5 shrink-0" aria-hidden />
      <span className="[overflow-wrap:anywhere]">{problem}</span>
    </p>
  ) : null;
  return { button, problem: shown };
}

const ICON = "size-3.5 shrink-0 max-[380px]:hidden";

/** One artifact in the Dashboard's small browser: the page in its sandboxed frame, filling the view. */
export function ArtifactViewer({ name, version }: { name: string; version?: number }) {
  const store = useStore();
  const [read, setRead] = useState<ArtifactResponse | { problem: string }>();
  const [attempt, setAttempt] = useState(0);
  const [reloads, setReloads] = useState(0);
  const [deleting, setDeleting] = useState(false);
  // Taking the question back puts focus on Delete again, where it was asked from.
  const deleteButton = useRef<HTMLButtonElement>(null);
  const backToDelete = useRef(false);
  useEffect(() => {
    if (!deleting && backToDelete.current) {
      backToDelete.current = false;
      deleteButton.current?.focus();
    }
  }, [deleting]);

  useArtifactPublishes(store, () => setAttempt((n) => n + 1));

  useEffect(() => {
    let live = true;
    store.source.artifact(name, version).then(
      (r) => live && setRead(r),
      (e: Error) => live && setRead({ problem: e.message }),
    );
    return () => {
      live = false;
    };
  }, [store, name, version, attempt]);

  if (read === undefined) return <ViewSkeleton view="artifact" />;
  if ("problem" in read) {
    return (
      <ErrorPage
        title={`Could not open ${name}`}
        reason={read.problem}
        actions={
          <>
            <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
            <a href={href({ view: "artifacts" })} className={buttonVariants({ variant: "secondary" })}>
              All artifacts
            </a>
          </>
        }
      >
        The page may have been published under another name, or this version is no longer kept: the last five are.
      </ErrorPage>
    );
  }

  const { artifact: a, versions } = read;
  const latest = versions.at(-1);
  // The frame names the version it shows, so a newer latest loads in it, and Reload asks again.
  const src = store.source.artifactPageUrl(a.name, a.version);
  const action = cn(buttonVariants({ variant: "secondary", size: "sm" }), "max-sm:flex-1");
  return (
    <article aria-label={a.title} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[var(--gutter)] pt-5 pb-5 max-sm:pt-4">
      <header className="flex min-w-0 flex-wrap items-end gap-x-6 gap-y-3">
        <div className="flex min-w-0 flex-[1_1_16rem] flex-col gap-1">
          <h1 className="font-display text-section font-medium [overflow-wrap:anywhere] text-ink">{a.title}</h1>
          <p className="text-small [overflow-wrap:anywhere] text-ink-3">
            <Facts artifact={a} version />
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full">
          {versions.length > 1 && (
            <Segmented
              label="Version"
              value={String(a.version)}
              onChange={(v) => go({ view: "artifact", name: a.name, version: Number(v) === latest ? undefined : Number(v) })}
              options={versions.map((v) => ({ value: String(v), label: v === latest ? `v${v} latest` : `v${v}` }))}
            />
          )}
          {/* On the narrowest phones the three share one row by their words alone. */}
          <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:w-full">
            <Button size="sm" className="max-sm:flex-1" onClick={() => setReloads((n) => n + 1)}>
              <RotateCw className={ICON} aria-hidden />
              Reload
            </Button>
            <a href={src} target="_blank" rel="noopener noreferrer" aria-label="Open in new tab" className={action}>
              <ExternalLink className={ICON} aria-hidden />
              <span className="max-sm:hidden">Open in new tab</span>
              <span className="sm:hidden">New tab</span>
            </a>
            <a href={store.source.artifactPageUrl(a.name, a.version, true)} download={`${a.name}.html`} className={action}>
              <Download className={ICON} aria-hidden />
              Download
            </a>
            {a.owner === store.source.me && !deleting && (
              <Button ref={deleteButton} size="sm" className="max-sm:flex-1" onClick={() => setDeleting(true)}>
                <Trash2 className={ICON} aria-hidden />
                Delete
              </Button>
            )}
          </div>
        </div>
      </header>
      {deleting && (
        <DeleteQuestion
          name={a.name}
          title={a.title}
          versions={versions.length}
          onCancel={() => {
            backToDelete.current = true;
            setDeleting(false);
          }}
        />
      )}
      <iframe
        key={`${src}#${reloads}`}
        src={src}
        sandbox={ARTIFACT_SANDBOX}
        referrerPolicy="no-referrer"
        title={`${a.title}, the page ${a.publishedBy.person} shared`}
        className="min-h-[20rem] w-full flex-1 rounded-[var(--r)] border border-rule bg-paper"
      />
      <p className="text-small text-ink-3">
        Shared by <Publisher by={a.publishedBy} />. It runs in a sandbox: it cannot read the Channel or act as you, but it is only as trustworthy as whoever
        published it.
      </p>
    </article>
  );
}

/**
 * Delete asks once, in place, as Stop does: it says what goes and that it cannot be undone,
 * and the answer deletes every kept version, then goes back to the folder. The Channel's
 * refusal shows under it. Escape takes the question back.
 */
function DeleteQuestion({ name, title, versions, onCancel }: { name: string; title: string; versions: number; onCancel: () => void }) {
  const store = useStore();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const remove = async () => {
    setBusy(true);
    setProblem(undefined);
    const result = await store.source.deleteArtifact(name);
    setBusy(false);
    if (!result.ok) return setProblem(result.reason);
    toast.success(`Deleted ${title}`);
    go({ view: "artifacts" });
  };
  return (
    <div
      role="group"
      aria-label={`Delete ${title}?`}
      className="flex flex-col gap-2 rounded-[var(--r)] border border-rule-2 px-3 py-2.5"
      onKeyDown={(e) => {
        if (e.key === "Escape" && !busy) {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-[1_1_18rem] text-small text-ink">
          Delete {title}? {versions === 1 ? "Its one version goes" : `All ${versions} of its versions go`} for everyone on the Channel. This cannot be undone.
        </p>
        <div className="flex items-center gap-2 max-sm:w-full">
          <Button size="sm" variant="primary" className="max-sm:flex-1" busy={busy} onClick={remove}>
            Delete artifact
          </Button>
          <Button size="sm" className="max-sm:flex-1" disabled={busy} onClick={onCancel} autoFocus>
            Cancel
          </Button>
        </div>
      </div>
      {problem && (
        <p role="alert" className="flex items-start gap-1.5 text-small text-ink">
          <TriangleAlert className="mt-[3px] size-3.5 shrink-0" aria-hidden />
          <span className="[overflow-wrap:anywhere]">{problem}</span>
        </p>
      )}
    </div>
  );
}
