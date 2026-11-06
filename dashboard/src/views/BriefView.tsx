/*
 * The Brief view (ADR 0042): the few short pages the Channel's Agents keep on what the repo's
 * product is and where it stands. The pages are listed with each one's age, the overview first
 * and the stuck page last; the page picked (#/brief/<page>, the overview by default) is read at
 * reading width with who last wrote it and when. The Dashboard only reads: Agents write the
 * pages with brief_write, and anyone asks about them through the Connector's brief tool.
 */
import { useEffect, useState } from "react";
import type { BriefAuthor, BriefPage, BriefResponse } from "@shared/index";
import { BRIEF_OVERVIEW } from "@shared/index";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { BriefMarkdown } from "@/components/domain/brief-markdown";
import { shortName } from "@/components/domain/fleet";
import { PageHead } from "@/components/shell/page-head";
import { EmptyState, EmptyView, ErrorPage, ViewSkeleton } from "@/components/shell/states";
import { useIndex, useStore } from "@/data/store";
import { ago } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/utils";

const ADR_BRIEF = "https://github.com/shlok1806/switchboard/blob/main/docs/adr/0042-the-brief-agents-keep-of-the-repo.md";

export function BriefView({ page }: { page?: string }) {
  const store = useStore();
  const [loaded, setLoaded] = useState<BriefResponse | null | undefined>(undefined);
  const [problem, setProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is what asks again.
  useEffect(() => {
    let live = true;
    store.source.brief().then(
      (r) => {
        if (!live) return;
        setProblem(undefined);
        setLoaded(r);
      },
      (e: Error) => live && setProblem(e.message),
    );
    return () => {
      live = false;
    };
  }, [store, attempt]);

  if (loaded === null) {
    return (
      <EmptyView view="Brief" title="The Brief is not on this Channel yet" action={<HowTheBriefWorks />}>
        This Channel's Worker predates the Brief. Its Agents cannot write one through it yet.
      </EmptyView>
    );
  }
  if (loaded === undefined) {
    return problem ? (
      <ErrorPage
        title="Could not read the Brief"
        reason={problem}
        actions={
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        }
      >
        The rest of the Channel is fine. Only the Brief did not load.
      </ErrorPage>
    ) : (
      <ViewSkeleton view="brief" />
    );
  }
  if (loaded.pages.length === 0) {
    return (
      <EmptyView view="Brief" title="No Brief yet" action={<HowTheBriefWorks />}>
        The Channel's Agents write the Brief with brief_write: an overview of the product, a page per area and what is stuck. It shows here, and the Connector's brief tool answers from it.
      </EmptyView>
    );
  }

  const { pages } = loaded;
  const wanted = page ?? BRIEF_OVERVIEW;
  // With no overview yet, the Brief opens at its first page.
  const shown = pages.find((p) => p.page === wanted) ?? (page === undefined ? pages[0] : undefined);
  const newest = pages.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full max-w-[72rem] flex-col gap-5 px-[var(--gutter)] pt-5 pb-12">
        <PageHead
          title="Brief"
          facts={[
            `${pages.length} ${pages.length === 1 ? "page" : "pages"}`,
            <>
              last written <time dateTime={newest.updatedAt}>{ago(newest.updatedAt)}</time>
            </>,
            "Agents keep it; the Connector reads it",
          ]}
        />
        <div className="grid gap-x-10 gap-y-6 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <nav aria-label="Pages" className="lg:sticky lg:top-5 lg:self-start">
            <ol className="flex flex-col border-t border-rule">
              {pages.map((p) => (
                <PageLink key={p.page} page={p} current={p.page === shown?.page} />
              ))}
            </ol>
          </nav>
          {shown ? (
            <Page key={shown.page} page={shown} />
          ) : (
            <EmptyState
              title={`No page ${wanted}`}
              action={
                <a href={href({ view: "brief" })} className={buttonVariants({ variant: "secondary" })}>
                  Read the overview
                </a>
              }
            >
              The Brief has no page by that name. Its Agents may have folded it into another.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  );
}

/** Links the decision that explains the Brief. */
function HowTheBriefWorks() {
  return (
    <a href={ADR_BRIEF} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
      How the Brief works
    </a>
  );
}

/** A page in the list: its title, then how long ago it was written. */
function PageLink({ page: p, current }: { page: BriefPage; current: boolean }) {
  return (
    <li className="border-b border-rule">
      <a
        href={href({ view: "brief", page: p.page })}
        aria-current={current ? "page" : undefined}
        className={cn(
          // On a desk the age sits under the title; on a phone beside it, so the list stays short above the page.
          "flex flex-col gap-0.5 px-2 py-2.5 transition-colors duration-[var(--dur)] hover:bg-paper-2 hover:no-underline max-lg:flex-row max-lg:items-baseline max-lg:justify-between max-lg:gap-3 max-lg:py-2",
          current && "bg-paper-3 hover:bg-paper-3",
        )}
      >
        <span className={cn("text-row [overflow-wrap:anywhere]", current ? "font-semibold text-ink" : "font-medium text-ink-2")}>{p.title}</span>
        <span className="shrink-0 text-small text-ink-3">
          <time dateTime={p.updatedAt}>{ago(p.updatedAt)}</time>
        </span>
      </a>
    </li>
  );
}

/** Who wrote a version: the Agent, linked, as its Person's. */
function Author({ by }: { by: BriefAuthor }) {
  const { agentById } = useIndex();
  const agent = agentById.get(by.agent);
  const name = agent ? `${by.person}/${shortName(agent)}` : by.nickname ? `${by.person}/${by.nickname}` : by.agent;
  return (
    <a href={href({ view: "agent", id: by.agent })} className="text-ink hover:underline">
      {name}
    </a>
  );
}

/** One page at reading width, with when and by whom it was last written. */
function Page({ page: p }: { page: BriefPage }) {
  return (
    <article aria-labelledby={`brief-${p.page}`} className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-col gap-1">
        <h2 id={`brief-${p.page}`} className="text-title font-semibold [overflow-wrap:anywhere] text-ink">
          {p.title}
        </h2>
        <p className="text-small text-ink-3">
          Written <time dateTime={p.updatedAt} title={new Date(p.updatedAt).toLocaleString()}>{ago(p.updatedAt)}</time> by <Author by={p.author} />
          {" · "}
          <span className="tabular-nums">version {p.version}</span>
        </p>
      </header>
      <BriefMarkdown text={p.text} title={p.title} />
    </article>
  );
}
