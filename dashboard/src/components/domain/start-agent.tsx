import { Fragment, useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";
import type { Agent, Host, PermissionMode } from "@shared/index";
import {
  DEFAULT_PERMISSION_MODE,
  MAX_BRIEF_LENGTH,
  MAX_NICKNAME_LENGTH,
  PERMISSION_MODES,
  cleanAbsolutePath,
  notUnderRootsReason,
  permissionModeWithin,
  underRoots,
} from "@shared/index";
import { Button } from "@/components/atoms/Button";
import { Sheet } from "@/components/shell/sheet";
import { useMe, useStore } from "@/data/store";
import { hostName } from "@/lib/format";
import { go } from "@/lib/router";
import { cn } from "@/lib/utils";

/** What each permission mode lets the Agent do without asking. */
const MODE_HINT: Record<PermissionMode, string> = {
  plan: "It reads and plans, and changes nothing.",
  dontAsk: "It runs only the tools allowed beforehand.",
  default: "It asks before edits and commands.",
  acceptEdits: "It edits files, and asks before commands.",
  auto: "A classifier approves each action.",
  bypassPermissions: "It runs with no permission checks.",
};

const FIELD =
  "h-[30px] min-w-0 rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 text-row text-ink placeholder:text-ink-3 hover:bg-paper-2 max-sm:text-[16px]";

/** Text whose `backticked` parts are commands or paths, set as code. */
export function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/`([^`]+)`/).map((part, i) =>
        // Odd parts were inside backticks.
        i % 2 === 1 ? (
          <code key={i} className="font-mono text-ink">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Per Channel's store, whether its Worker has Hosts: asked once, so every button and empty state agrees. */
const hostsSupported = new WeakMap<object, Promise<boolean>>();

/** Whether this Channel's Worker has Hosts at all (ADR 0015): `null` while asking. */
export function useHostsSupported(): boolean | null {
  const store = useStore();
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    let asked = hostsSupported.get(store);
    if (asked === undefined) {
      // Only an answer is kept: a failed read is asked again by the next button or view that mounts.
      asked = store.source.hosts().then((r) => r !== null);
      hostsSupported.set(store, asked);
      asked.catch(() => hostsSupported.delete(store));
    }
    asked.then(
      (s) => live && setSupported(s),
      () => live && setSupported(false),
    );
    return () => {
      live = false;
    };
  }, [store]);
  return supported;
}

/** This Person's own Hosts, and the Channel's cap on Agents Hosts run. `null` while loading. */
function useMyHosts() {
  const store = useStore();
  const me = useMe();
  const [state, setState] = useState<{ hosts: Host[]; cap?: number; running?: number; problem?: string } | null>(null);
  useEffect(() => {
    let live = true;
    store.source
      .hosts()
      .then((r) => live && setState(r === null ? { hosts: [] } : { hosts: r.hosts.filter((h) => h.person === me), cap: r.cap, running: r.running }))
      .catch((e: Error) => live && setState({ hosts: [], problem: e.message }));
    return () => {
      live = false;
    };
  }, [store, me]);
  return state;
}

/** One field, its label above it in 13 ink-3 (design.md), a note under it. */
function Field({ label, optional, hint, children }: { label: string; optional?: boolean; hint?: ReactNode; children: ReactNode }) {
  return (
    // The hint sits outside the label: it may hold buttons of its own.
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="flex min-w-0 flex-col gap-1 text-small text-ink-3">
        <span>
          {label} {optional && <span className="text-ink-4">optional</span>}
        </span>
        {children}
      </label>
      {hint && <div className="min-w-0 text-small text-ink-3">{hint}</div>}
    </div>
  );
}

// One Start an Agent sheet for the whole Dashboard: the Hosts page, the Agents toolbar, the
// Canvas and the palette all open the same one.
let sheetOpen = false;
const sheetListeners = new Set<() => void>();
function setSheet(open: boolean) {
  sheetOpen = open;
  for (const l of sheetListeners) l();
}

/** Opens the Start an Agent sheet. */
export function openStartAgent() {
  setSheet(true);
}

/**
 * Start a Claude Code Agent on one of this Person's Hosts, with no terminal (ADR 0015).
 * Hidden on a Channel whose Worker has no Hosts.
 */
export function StartAgentButton() {
  const supported = useHostsSupported();
  if (!supported) return null;
  return (
    <Button variant="primary" onClick={openStartAgent}>
      Start an Agent
    </Button>
  );
}

/** The Start an Agent sheet, mounted once by the app. */
export function StartAgentSheet() {
  const open = useSyncExternalStore(
    (l) => {
      sheetListeners.add(l);
      return () => sheetListeners.delete(l);
    },
    () => sheetOpen,
  );
  // While a start is asked for, the sheet stays: closing it would hide the answer.
  const [busy, setBusy] = useState(false);
  // Unmounted (a test, or the app torn down), it is closed: the next mount starts closed.
  useEffect(() => () => setSheet(false), []);
  const loaded = useMyHosts();
  const close = () => setSheet(false);
  const hosts = loaded?.hosts ?? [];
  return (
    <Sheet
      open={open}
      onClose={close}
      locked={busy}
      title="Start an Agent"
      description={
        loaded === null
          ? "Looking for your Hosts"
          : hosts.length === 0
            ? (loaded.problem ?? "A Host starts Claude Code Agents on one of your machines, with no terminal. You have none on this Channel yet.")
            : "Claude Code, on one of your Hosts. It joins the Channel like any other Agent."
      }
      actions={
        <>
          <Button type="button" disabled={busy} onClick={close}>
            {hosts.length === 0 ? "Close" : "Cancel"}
          </Button>
          {hosts.length > 0 && <StartButton busy={busy} />}
        </>
      }
    >
      {open && loaded !== null && (hosts.length === 0 ? <NoHosts /> : <StartAgentForm hosts={hosts} cap={loaded.cap} running={loaded.running} busy={busy} setBusy={setBusy} onDone={close} />)}
    </Sheet>
  );
}

const FORM_ID = "start-agent";

// The form reports whether Start may be pressed; the button sits in the sheet's action row.
let canStart = false;
const startListeners = new Set<() => void>();
function setCanStart(v: boolean) {
  if (v === canStart) return;
  canStart = v;
  for (const l of startListeners) l();
}

function StartButton({ busy }: { busy: boolean }) {
  const ready = useSyncExternalStore(
    (l) => {
      startListeners.add(l);
      return () => startListeners.delete(l);
    },
    () => canStart,
  );
  return (
    <Button type="submit" form={FORM_ID} variant="primary" busy={busy} disabled={!ready}>
      Start Agent
    </Button>
  );
}

function NoHosts() {
  return (
    <>
      <p className="text-row text-ink">Install one on the machine, naming the folders its Agents may work in:</p>
      <code className="block rounded-[var(--r)] bg-paper-2 px-2.5 py-1.5 text-small [overflow-wrap:anywhere] text-ink">switchboard host install --root ~/code/your-repo</code>
    </>
  );
}

function StartAgentForm({
  hosts,
  cap,
  running,
  busy,
  setBusy,
  onDone,
}: {
  hosts: Host[];
  cap?: number;
  running?: number;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const store = useStore();
  const [chosenHost, setChosenHost] = useState<string>();
  const host = hosts.find((h) => h.name === chosenHost) ?? hosts.find((h) => h.live) ?? hosts[0]!;
  const [cwd, setCwd] = useState<string>();
  const [brief, setBrief] = useState("");
  const [nickname, setNickname] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>();
  const [problem, setProblem] = useState<string>();
  // Set at once, so a second click before React renders `busy` does not start a second Agent.
  const starting = useRef(false);
  const folderInput = useRef<HTMLInputElement>(null);

  const modes = PERMISSION_MODES.filter((m) => permissionModeWithin(m, host.maxPermissionMode));
  const chosenMode = mode && modes.includes(mode) ? mode : modes.includes(DEFAULT_PERMISSION_MODE) ? DEFAULT_PERMISSION_MODE : modes.at(-1);
  const folder = cwd ?? host.roots[0] ?? "";
  // The folder, checked as the Host checks it before anything is asked: an absolute path,
  // under one of its roots.
  const path = folder.trim();
  const clean = cleanAbsolutePath(path);
  const refusal = !path
    ? undefined
    : !clean
      ? "The folder must be an absolute path on the Host, with no . or .. in it."
      : !underRoots(clean, host.roots)
        ? notUnderRootsReason(clean, host.name, host.roots)
        : undefined;
  const full = cap !== undefined && running !== undefined && running >= cap;
  const ready = !busy && host.live && !!path && !refusal && !!chosenMode && !full;
  useEffect(() => {
    setCanStart(ready);
    return () => setCanStart(false);
  }, [ready]);

  // A long path shows its end, the part that names the repo, unless the Person is editing it.
  useEffect(() => {
    const input = folderInput.current;
    if (input && document.activeElement !== input) input.scrollLeft = input.scrollWidth;
  }, [folder]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !clean || !chosenMode || starting.current) return;
    starting.current = true;
    setBusy(true);
    setProblem(undefined);
    const result = await store.source.spawnAgent({
      host: host.name,
      cli: "claude-code",
      cwd: clean,
      permissionMode: chosenMode,
      ...(brief.trim() ? { brief: brief.trim() } : {}),
      ...(nickname.trim() ? { nickname: nickname.trim() } : {}),
      ...(model.trim() ? { model: model.trim() } : {}),
    });
    starting.current = false;
    setBusy(false);
    if (!result.ok) return setProblem(result.reason);
    const { agent } = result.answer;
    onDone();
    if (agent) {
      toast.success(`${agent.nickname ?? agent.id} is running on ${hostName(result.answer.host)}`);
      go({ view: "agent", id: agent.id });
    } else {
      toast(`${hostName(result.answer.host)} is still starting it. It appears here once it is on the Channel.`);
    }
  };

  return (
    <form id={FORM_ID} onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      {hosts.length > 1 && (
        <Field label="Host">
          <select
            value={host.name}
            onChange={(e) => {
              setChosenHost(e.target.value);
              // Another Host has other folders.
              setCwd(undefined);
            }}
            className={`${FIELD} pr-7`}
          >
            {hosts.map((h) => (
              <option key={h.id} value={h.name}>
                {h.name}
                {h.live ? "" : " (Offline)"}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="flex min-w-0 flex-col gap-1.5">
        <Field label="Folder">
          <input
            ref={folderInput}
            name="cwd"
            value={folder}
            onChange={(e) => setCwd(e.target.value)}
            spellCheck={false}
            aria-invalid={refusal ? true : undefined}
            aria-describedby={refusal ? "start-agent-folder-refusal" : undefined}
            className={cn(FIELD, "font-mono" /* taste-skill-ignore: a path is code */, refusal && "border-ink")}
          />
        </Field>
        {refusal ? (
          <p id="start-agent-folder-refusal" className="text-small text-ink">
            <WithCode text={refusal} />
          </p>
        ) : (
          <FolderChoices host={host} value={folder} onPick={setCwd} />
        )}
      </div>
      <Field label="Brief" optional hint="Its first prompt, sent as your Directive.">
        <textarea
          name="brief"
          rows={4}
          autoFocus
          maxLength={MAX_BRIEF_LENGTH}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Fix the login redirect, then open a PR."
          className="min-w-0 resize-none rounded-[var(--r)] border border-rule-2 bg-paper px-2.5 py-1.5 text-row text-ink placeholder:text-ink-3 hover:bg-paper-2 max-sm:text-[16px]"
        />
      </Field>
      <div className="grid min-w-0 gap-4 sm:grid-cols-2">
        <Field label="Nickname" optional>
          <input name="nickname" maxLength={MAX_NICKNAME_LENGTH} value={nickname} onChange={(e) => setNickname(e.target.value)} className={FIELD} />
        </Field>
        <Field label="Model" optional>
          <input name="model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="Claude Code's default" spellCheck={false} className={FIELD} />
        </Field>
      </div>
      <Field label="Permission mode" hint={chosenMode ? MODE_HINT[chosenMode] : undefined}>
        <select name="permissionMode" value={chosenMode} onChange={(e) => setMode(e.target.value as PermissionMode)} className={`${FIELD} pr-7`}>
          {modes.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>
      {cap !== undefined && running !== undefined && <CapMeter cap={cap} running={running} />}
      {!host.live && (
        <p className="text-small text-ink">
          {host.name} is Offline. Start <code className="text-ink">switchboard host run</code> there, or wait for it to come back.
        </p>
      )}
      {problem && (
        <p role="alert" className="text-small text-ink">
          <WithCode text={problem} />
        </p>
      )}
    </form>
  );
}

/** How many Agents Hosts run on the Channel against its cap, shown before Start. */
function CapMeter({ cap, running }: { cap: number; running: number }) {
  const full = running >= cap;
  return (
    <div className="flex flex-col gap-1">
      <p className="flex items-center gap-2.5 text-small text-ink-3 tabular-nums">
        <span
          role="meter"
          aria-label="Agents running on Hosts"
          aria-valuemin={0}
          aria-valuemax={cap}
          aria-valuenow={running}
          className="relative h-1 w-14 shrink-0 bg-rule"
        >
          <span className="absolute inset-y-0 left-0 bg-ink-2" style={{ width: `${Math.min(100, (running / Math.max(cap, 1)) * 100)}%` }} />
        </span>
        <span className={full ? "text-ink" : undefined}>
          {running} of {cap} Agents running on Hosts
        </span>
      </p>
      {full && <p className="text-small text-ink">The Channel runs its cap. Stop one of them before starting another.</p>}
    </div>
  );
}

/**
 * The Host's folders, any of which (or a folder under one) an Agent may start in: one
 * click puts it in the field. A long path wraps at its slashes rather than being cut.
 */
function FolderChoices({ host, value, onPick }: { host: Host; value: string; onPick: (root: string) => void }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-small text-ink-3">
      <span>On {host.name}, in one of its folders or under it:</span>
      <span className="flex min-w-0 flex-wrap gap-1.5">
        {host.roots.map((root) => (
          <button
            key={root}
            type="button"
            onClick={() => onPick(root)}
            aria-pressed={value === root}
            className={cn(
              "inline-flex min-h-[26px] max-w-full items-center rounded-[var(--r)] border px-2 py-0.5 text-left text-label font-medium transition-colors duration-[var(--dur)] active:translate-y-px",
              value === root ? "border-ink text-ink" : "border-rule text-ink-2 hover:border-ink-3 hover:text-ink",
            )}
          >
            <code className="text-label break-words">
              {root.split("/").map((part, i, all) => (
                <Fragment key={i}>
                  {part}
                  {i < all.length - 1 && (
                    <>
                      /<wbr />
                    </>
                  )}
                </Fragment>
              ))}
            </code>
          </button>
        ))}
      </span>
    </div>
  );
}

/** How long Stop waits for the Agent to go Gone before it may be asked again. */
const STOP_WAIT_MS = 30_000;

/** Stop an Agent one of this Person's Hosts runs: its session ends and it goes Gone. */
export function StopAgentButton({ agent }: { agent: Agent }) {
  const store = useStore();
  const me = useMe();
  const [confirming, setConfirming] = useState(false);
  // Taking the question back puts focus on Stop again, where it was.
  const stopButton = useRef<HTMLButtonElement>(null);
  const backToStop = useRef(false);
  useEffect(() => {
    if (!confirming && backToStop.current) {
      backToStop.current = false;
      stopButton.current?.focus();
    }
  }, [confirming]);
  const takeBack = () => {
    backToStop.current = true;
    setConfirming(false);
  };
  const [busy, setBusy] = useState(false);
  const asking = useRef(false);
  // Asked to stop: Stop stays off until the Agent is Gone (and this button with it), or the
  // Host has had long enough that asking again is fair. Live to Idle on the way is not an answer.
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!stopping) return;
    const timer = setTimeout(() => setStopping(false), STOP_WAIT_MS);
    return () => clearTimeout(timer);
  }, [stopping]);
  if (agent.host === undefined || agent.person !== me || agent.presence === "gone") return null;
  const name = agent.nickname ?? agent.id;

  const stop = async () => {
    if (asking.current) return;
    asking.current = true;
    setBusy(true);
    const result = await store.source.stopAgent(agent.id);
    asking.current = false;
    setBusy(false);
    setConfirming(false);
    if (!result.ok) return toast.error(result.reason);
    setStopping(true);
    toast.success(`Asked ${hostName(agent.host ?? "")} to stop ${name}`);
  };

  // Stop asks once, in place: the button becomes the question and its answer.
  if (confirming) {
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: Escape anywhere in the question takes it back.
      <span
        role="group"
        aria-label={`Stop ${name}?`}
        className="inline-flex flex-wrap items-center gap-2"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            takeBack();
          }
        }}
      >
        <span className="text-small text-ink">
          Stop {name}? {hostName(agent.host)} ends its session; a Claim it holds goes Stale.
        </span>
        <Button type="button" variant="primary" busy={busy} onClick={stop}>
          Stop Agent
        </Button>
        <Button type="button" disabled={busy} onClick={takeBack} autoFocus>
          Cancel
        </Button>
      </span>
    );
  }
  return (
    <Button ref={stopButton} disabled={stopping} onClick={() => setConfirming(true)}>
      {stopping ? "Stopping" : "Stop"}
    </Button>
  );
}
