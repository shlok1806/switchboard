/*
 * The Channel's settings (ADR 0044). One so far: the repo's own Langfuse project, which the
 * Connector's costs tool reads live. Anyone on the Channel sees whether one is connected, its
 * host, its project and the public key's last 4 characters; only the Channel's owner (an admin
 * of the repo) connects it, replaces its keys or removes it. The secret key is typed once and
 * never comes back: the Worker keeps it sealed and no route returns it.
 */
import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { LangfuseConnection, LangfuseSettingsResponse } from "@shared/index";
import { LANGFUSE_CLOUD_HOSTS } from "@shared/index";
import { Button } from "@/components/atoms/Button";
import { PageHead } from "@/components/shell/page-head";
import { Section } from "@/components/shell/section";
import { EmptyView, ErrorPage, ViewSkeleton } from "@/components/shell/states";
import { useChannel, useStore } from "@/data/store";
import { ago } from "@/lib/format";
import { channelRepo } from "@/lib/session";

const ADR = "https://github.com/shlok1806/switchboard/blob/main/docs/adr/0044-the-costs-tool-reads-the-repos-own-langfuse.md";
const FIELD =
  "h-[30px] w-full min-w-0 rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-3 hover:bg-paper-2 max-sm:text-[16px]";
const SELF_HOSTED = "self-hosted";

export function SettingsView() {
  const store = useStore();
  const { snapshot } = useChannel();
  const repo = snapshot?.channel.repo ?? channelRepo() ?? "";
  const [loaded, setLoaded] = useState<LangfuseSettingsResponse | null | undefined>(undefined);
  const [problem, setProblem] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is what asks again.
  useEffect(() => {
    let live = true;
    store.source.langfuse().then(
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
      <EmptyView view="Settings" title="This Channel has no settings yet">
        This Channel's Worker predates the Channel's settings. Its Connector has no costs tool yet.
      </EmptyView>
    );
  }
  if (loaded === undefined) {
    return problem ? (
      <ErrorPage
        title="Could not read the Channel's settings"
        reason={problem}
        actions={
          <Button variant="primary" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        }
      >
        The rest of the Channel is fine. Only its settings did not load.
      </ErrorPage>
    ) : (
      <ViewSkeleton view="settings" />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="flex w-full max-w-[44rem] flex-col gap-6 px-[var(--gutter)] pt-5 pb-12">
        <PageHead
          title="Settings"
          facts={[
            repo && <code key="repo">{repo}</code>,
            loaded.canManage ? "you are its owner" : "only the Channel's owner changes these",
          ]}
        />
        <LangfuseSection settings={loaded} onChange={setLoaded} />
      </div>
    </div>
  );
}

function LangfuseSection({ settings, onChange }: { settings: LangfuseSettingsResponse; onChange: (s: LangfuseSettingsResponse) => void }) {
  const [editing, setEditing] = useState(false);
  const { langfuse, canManage } = settings;
  const connected = langfuse !== null;
  return (
    <Section title="Langfuse" meta={connected ? "connected" : "not connected"}>
      <div className="flex flex-col gap-4">
        <p className="text-row text-ink-2">
          The Connector's costs tool reads what running the product costs, live from the repo's own Langfuse project: cost, tokens, calls, errors and
          latency by model, trace name, day or week. Nothing is copied into the Channel.{" "}
          <a href={ADR} target="_blank" rel="noreferrer" className="text-ink underline-offset-2 hover:underline">
            How it works
          </a>
        </p>
        {connected && <Connected project={langfuse} />}
        {canManage ? (
          connected && !editing ? (
            <OwnerActions onReplace={() => setEditing(true)} onRemoved={onChange} />
          ) : (
            <ConnectForm
              replacing={connected}
              onCancel={connected ? () => setEditing(false) : undefined}
              onSaved={(s) => {
                setEditing(false);
                onChange(s);
              }}
            />
          )
        ) : (
          !connected && (
            <p className="text-row text-ink">No Langfuse project is connected. The Channel's owner, an admin of the repo on GitHub, connects one here.</p>
          )
        )}
      </div>
    </Section>
  );
}

/** What anyone sees of a connected project: never its secret key. */
function Connected({ project }: { project: LangfuseConnection }) {
  const rows: [string, ReactNode][] = [
    ["Project", <span key="p" className="font-medium text-ink">{project.project.name}</span>],
    ["Host", <code key="h" className="[overflow-wrap:anywhere] text-ink">{project.host}</code>],
    [
      "Public key",
      <code key="k" className="text-ink">
        <span className="text-ink-3">pk-lf-…</span>
        {project.publicKeyEnd}
      </code>,
    ],
    ["Secret key", <span key="s" className="text-ink-2">kept sealed, never shown</span>],
    [
      "Connected",
      <span key="c" className="text-ink-2">
        by <span className="text-ink">{project.connectedBy}</span>,{" "}
        <time dateTime={project.connectedAt} title={new Date(project.connectedAt).toLocaleString()}>
          {ago(project.connectedAt)}
        </time>
      </span>,
    ],
  ];
  return (
    <dl aria-label="Connected project" className="grid grid-cols-[8rem_minmax(0,1fr)] border-t border-rule text-row max-sm:grid-cols-[6.5rem_minmax(0,1fr)]">
      {rows.map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="border-b border-rule py-2 text-small text-ink-3">{term}</dt>
          <dd className="min-w-0 border-b border-rule py-2">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OwnerActions({ onReplace, onRemoved }: { onReplace: () => void; onRemoved: (s: LangfuseSettingsResponse) => void }) {
  const store = useStore();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const remove = async () => {
    setBusy(true);
    const result = await store.source.removeLangfuse();
    setBusy(false);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    toast("Langfuse removed. The costs tool says no project is connected.");
    onRemoved(result.settings);
  };
  if (confirming) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-row text-ink">Remove the project? Its keys are deleted from the Channel, and the costs tool stops answering until it is connected again.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" busy={busy} onClick={() => void remove()}>
            Remove
          </Button>
          <Button onClick={() => setConfirming(false)} disabled={busy}>
            Keep it
          </Button>
        </div>
        {problem && (
          <p role="alert" className="text-small text-ink">
            {problem}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={onReplace}>Replace keys</Button>
      <Button variant="ghost" onClick={() => setConfirming(true)}>
        Remove
      </Button>
    </div>
  );
}

function ConnectForm({
  replacing,
  onCancel,
  onSaved,
}: {
  replacing: boolean;
  onCancel?: () => void;
  onSaved: (s: LangfuseSettingsResponse) => void;
}) {
  const store = useStore();
  const id = useId();
  const [region, setRegion] = useState(LANGFUSE_CLOUD_HOSTS[0]?.host ?? SELF_HOSTED);
  const [selfHosted, setSelfHosted] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setProblem(undefined);
    const host = region === SELF_HOSTED ? selfHosted : region;
    const result = await store.source.connectLangfuse({ host, publicKey, secretKey });
    setBusy(false);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    // The secret key leaves the page with the form: nothing here keeps it.
    setSecretKey("");
    toast(replacing ? "Langfuse keys replaced." : `Langfuse connected: ${result.settings.langfuse?.project.name ?? "the project"}.`);
    onSaved(result.settings);
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label={replacing ? "Replace the Langfuse keys" : "Connect Langfuse"} className="flex min-w-0 flex-col gap-4">
      <p className="text-small text-ink-3">
        In Langfuse, open the project's Settings, then API Keys, and create a key pair. The secret key is checked with Langfuse, kept sealed, and never shown again.
      </p>
      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor={`${id}-host`} className="text-small text-ink-3">
          Host
        </label>
        <select id={`${id}-host`} value={region} onChange={(e) => setRegion(e.target.value)} className={FIELD}>
          {LANGFUSE_CLOUD_HOSTS.map((h) => (
            <option key={h.host} value={h.host}>
              {h.label} ({h.host.replace("https://", "")})
            </option>
          ))}
          <option value={SELF_HOSTED}>Self-hosted</option>
        </select>
        {region === SELF_HOSTED && (
          <input
            aria-label="Self-hosted Langfuse address"
            required
            type="url"
            inputMode="url"
            placeholder="https://langfuse.example.com"
            value={selfHosted}
            onChange={(e) => setSelfHosted(e.target.value)}
            spellCheck={false}
            className={FIELD}
          />
        )}
      </div>
      <label className="flex min-w-0 flex-col gap-1.5 text-small text-ink-3">
        Public key
        <input
          name="publicKey"
          required
          placeholder="pk-lf-..."
          value={publicKey}
          onChange={(e) => setPublicKey(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          className={`${FIELD} font-mono`}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1.5 text-small text-ink-3">
        Secret key
        <input
          name="secretKey"
          required
          type="password"
          placeholder="sk-lf-..."
          value={secretKey}
          onChange={(e) => setSecretKey(e.target.value)}
          autoComplete="new-password"
          spellCheck={false}
          className={`${FIELD} font-mono`}
        />
      </label>
      {problem && (
        <p role="alert" className="text-small text-ink">
          {problem}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" busy={busy}>
          {replacing ? "Save keys" : "Connect"}
        </Button>
        {onCancel && (
          <Button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
