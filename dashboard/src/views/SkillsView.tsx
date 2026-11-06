/*
 * The Skills view: the Claude Code skills Persons share on the Channel (ADR 0039), by name,
 * each at its latest version with what it does, its files and who published it. A skill opens
 * in the inspector (#/skills/<name>[/<version>]), or on a phone in a sheet, with every file in
 * full and the command that installs it. The Dashboard only reads: a Person publishes and
 * installs from their terminal, or asks their own Agent, whose CLI asks them to approve it.
 */
import { useEffect, useState } from "react";
import type { Skill, SkillPublisher, SkillSummary, SkillsResponse } from "@shared/index";
import { Button, buttonVariants } from "@/components/atoms/Button";
import { Chip } from "@/components/atoms/Chip";
import { shortName } from "@/components/domain/fleet";
import { RowFrame } from "@/components/domain/log";
import { InspectorFrame, InspectorMissing, SheetClose } from "@/components/shell/inspector";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { CopyCommand, EmptyView, ErrorPage, ViewSkeleton } from "@/components/shell/states";
import { useIndex, useStore } from "@/data/store";
import { useIsMobile } from "@/hooks/use-mobile";
import { ago, clock } from "@/lib/format";
import { go, href } from "@/lib/router";

export function SkillsView({ name, version }: { name?: string; version?: number }) {
  const store = useStore();
  const mobile = useIsMobile();
  const [loaded, setLoaded] = useState<SkillsResponse | null | undefined>(undefined);
  const [problem, setProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is what asks again.
  useEffect(() => {
    let live = true;
    store.source.skills().then(
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
      <EmptyView view="Skills" title="Skills are not on this Channel yet" action={<HowSkillsWork />}>
        This Channel's Worker predates shared skills. Persons on it cannot share skills through it yet.
      </EmptyView>
    );
  }
  if (loaded === undefined) {
    return problem ? (
      <ErrorPage
        title="Could not read the skills"
        reason={problem}
        actions={
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        }
      >
        The rest of the Channel is fine. Only the shared skills did not load.
      </ErrorPage>
    ) : (
      <ViewSkeleton view="skills" />
    );
  }
  if (loaded.skills.length === 0) {
    return (
      <EmptyView view="Skills" title="No skills shared yet" action={<CopyCommand command="switchboard skills publish <name>" />}>
        A Person shares one of their Claude Code skills by asking their agent to publish it, or from their terminal. Every Person on the Channel can then read and install it.
      </EmptyView>
    );
  }

  const { skills } = loaded;
  const close = () => go({ view: "skills" });
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <div className="flex w-full max-w-[60rem] flex-col gap-5 px-[var(--gutter)] pt-5 pb-12">
          <PageHead
            title="Skills"
            facts={[`${skills.length} ${skills.length === 1 ? "skill" : "skills"}`, "by name", "Persons share them from their terminal or through their agent"]}
          />
          <ol className="border-t border-rule" aria-label="Skills">
            {skills.map((s) => (
              <RowFrame key={s.name} selected={s.name === name} onPick={() => go({ view: "skills", name: s.name })} className="flex flex-col gap-1.5 px-2 py-3.5">
                <SkillLine skill={s} />
              </RowFrame>
            ))}
          </ol>
        </div>
      </div>
      {name !== undefined && <SkillInspector key={`${name}/${version ?? ""}`} name={name} version={version} sheet={mobile} onClose={close} />}
    </div>
  );
}

const ADR_SKILLS = "https://github.com/shlok1806/switchboard/blob/main/docs/adr/0039-persons-share-skills-on-the-channel.md";

/** Links the decision that explains shared skills. */
function HowSkillsWork() {
  return (
    <a href={ADR_SKILLS} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
      How skills work
    </a>
  );
}

/** A skill's name and version (left out where a heading names them), what it does, then its files, size, publisher and age. */
function SkillLine({ skill: s, named = true }: { skill: SkillSummary; named?: boolean }) {
  return (
    <>
      {named && (
        <p className="flex flex-wrap items-baseline gap-x-2 text-row">
          <span className="font-semibold [overflow-wrap:anywhere] text-ink">{s.name}</span>
          <span className="text-small text-ink-3 tabular-nums">v{s.version}</span>
        </p>
      )}
      {s.description && <p className="max-w-[72ch] text-row break-words text-ink-2">{s.description}</p>}
      <p className="text-small text-ink-3">
        {s.paths.length} {s.paths.length === 1 ? "file" : "files"}
        {" · "}
        {size(s.size)}
        {" · "}
        <Publisher by={s.publishedBy} />
        {" · "}
        <time dateTime={s.publishedAt} title={clock(s.publishedAt)}>
          {ago(s.publishedAt)}
        </time>
      </p>
    </>
  );
}

/** Who published a version: the Agent, linked, when one did it for its Person. */
function Publisher({ by }: { by: SkillPublisher }) {
  const { agentById } = useIndex();
  const agent = by.agent === undefined ? undefined : agentById.get(by.agent);
  if (agent) {
    return (
      <a href={href({ view: "agent", id: agent.id })} className="text-ink hover:underline">
        {by.person}/{shortName(agent)}
      </a>
    );
  }
  return <span>{by.agent ?? by.person}</span>;
}

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** One version of a skill in the inspector: its versions, how to install it, and every file in full. */
function SkillInspector({ name, version, sheet, onClose: close }: { name: string; version?: number; sheet: boolean; onClose: () => void }) {
  const store = useStore();
  const onClose = sheet ? close : undefined;
  const [read, setRead] = useState<{ skill: Skill; versions: number[] } | { problem: string }>();

  useEffect(() => {
    let live = true;
    store.source.skill(name, version).then(
      (r) => live && setRead(r),
      (e: Error) => live && setRead({ problem: e.message }),
    );
    return () => {
      live = false;
    };
  }, [store, name, version]);

  if (read && "problem" in read) {
    return (
      <InspectorMissing title="Could not read the skill" sheet={sheet} onClose={close}>
        {read.problem}
      </InspectorMissing>
    );
  }
  const latest = read?.versions.at(-1);
  const install = read && `switchboard skills install ${name}${read.skill.version === latest ? "" : ` --version ${read.skill.version}`}`;
  return (
    <InspectorFrame label={`${name}, in the inspector`} onClose={onClose}>
      {!read ? (
        <p className="text-small text-ink-3">Reading {name}</p>
      ) : (
        <>
          <header className="flex items-start gap-2">
            <h2 className="min-w-0 flex-1 text-title font-semibold [overflow-wrap:anywhere] text-ink">
              {name} <span className="font-normal text-ink-3 tabular-nums">v{read.skill.version}</span>
            </h2>
            <SheetClose onClose={onClose} />
          </header>
          <div className="flex flex-col gap-1.5">
            <SkillLine skill={read.skill} named={false} />
          </div>
          {read.versions.length > 1 && (
            <div role="group" aria-label="Version" className="flex flex-wrap gap-1.5">
              {read.versions.map((v) => (
                <Chip key={v} on={v === read.skill.version} onClick={() => go({ view: "skills", name, version: v === latest ? undefined : v })}>
                  v{v}
                  {v === latest && " latest"}
                </Chip>
              ))}
            </div>
          )}
          <Section title="Install" as="h3" bodyClassName="flex flex-col gap-2">
            {install && <CopyCommand command={install} />}
            <p className="text-small text-ink-2">
              Your terminal shows the whole skill, and what it changes in what you have installed, before it writes anything. Or ask your agent to install it: Claude Code and Codex ask you to approve it first.
            </p>
          </Section>
          <Section title="Files" meta={`${read.skill.files.length} ${read.skill.files.length === 1 ? "file" : "files"} · digest ${read.skill.digest.slice(0, 12)}`} as="h3" bodyClassName="flex flex-col gap-4">
            {read.skill.files.map((f) => (
              <figure key={f.path} className="flex min-w-0 flex-col gap-1.5">
                <figcaption>
                  <code className="text-small [overflow-wrap:anywhere] text-ink-2">{f.path}</code>
                </figcaption>
                <pre className="max-h-[28rem] overflow-auto rounded-[var(--r)] border border-rule bg-paper-2 px-3 py-2 font-mono text-small whitespace-pre-wrap [overflow-wrap:anywhere] text-ink">{f.content}</pre>
              </figure>
            ))}
          </Section>
        </>
      )}
    </InspectorFrame>
  );
}
