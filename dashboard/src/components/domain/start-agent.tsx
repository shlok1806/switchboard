import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Plus, Square } from "lucide-react";
import { toast } from "sonner";
import type { Agent, Host, PermissionMode, Presence } from "@shared/index";
import {
  DEFAULT_PERMISSION_MODE,
  MAX_BRIEF_LENGTH,
  MAX_NICKNAME_LENGTH,
  PERMISSION_MODES,
  permissionModeWithin,
} from "@shared/index";
import { Button } from "@/components/atoms/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMe, useStore } from "@/data/store";
import { go } from "@/lib/router";

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
  "h-10 rounded-md border border-line-strong bg-field px-3 text-body text-ink outline-none placeholder:text-ink-3 focus-visible:border-accent max-md:text-[16px]";

/** A Host by the name its Person gave it. On this Person's own Dashboard the person part says nothing. */
export function hostName(id: string): string {
  return id.slice(id.indexOf("/") + 1);
}

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
      asked = store.source.hosts().then(
        (r) => r !== null,
        () => false,
      );
      hostsSupported.set(store, asked);
    }
    asked.then((s) => live && setSupported(s));
    return () => {
      live = false;
    };
  }, [store]);
  return supported;
}

/** This Person's own Hosts. `null` while loading; `hosts` is null when the Channel's Worker has no Hosts. */
function useMyHosts() {
  const store = useStore();
  const me = useMe();
  const [state, setState] = useState<{ hosts: Host[] | null; problem?: string } | null>(null);
  useEffect(() => {
    let live = true;
    store.source
      .hosts()
      .then((r) => live && setState({ hosts: r === null ? null : r.hosts.filter((h) => h.person === me) }))
      .catch((e: Error) => live && setState({ hosts: [], problem: e.message }));
    return () => {
      live = false;
    };
  }, [store, me]);
  return state;
}

function Field({ label, optional, hint, children }: { label: string; optional?: boolean; hint?: ReactNode; children: ReactNode }) {
  return (
    // The hint sits outside the label: it may hold buttons of its own.
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="flex min-w-0 flex-col gap-1.5">
        <span className="text-small font-medium">
          {label} {optional && <span className="font-normal text-ink-3">optional</span>}
        </span>
        {children}
      </label>
      {hint && <div className="min-w-0 text-small text-ink-3">{hint}</div>}
    </div>
  );
}

/**
 * Start a Claude Code Agent on one of this Person's Hosts, with no terminal (ADR 0015).
 * Hidden on a Channel whose Worker has no Hosts.
 */
export function StartAgentButton() {
  const supported = useHostsSupported();
  const [open, setOpen] = useState(false);
  // While a start is asked for, the dialog stays: closing it would hide the answer.
  const [busy, setBusy] = useState(false);

  if (!supported) return null;
  return (
    <>
      <Button variant="action" size="sm" onClick={() => setOpen(true)} className="gap-1">
        <Plus className="size-4" aria-hidden /> <span>Start an Agent</span>
      </Button>
      <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : setOpen(next))}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          {open && <StartAgentForm busy={busy} setBusy={setBusy} onDone={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  );
}

export function StartAgentForm({
  busy,
  setBusy,
  onDone,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onDone: () => void;
}) {
  const store = useStore();
  const loaded = useMyHosts();
  const hosts = loaded?.hosts ?? [];
  const [chosenHost, setChosenHost] = useState<string>();
  const host = hosts.find((h) => h.name === chosenHost) ?? hosts.find((h) => h.live) ?? hosts[0];
  const [cwd, setCwd] = useState<string>();
  const [brief, setBrief] = useState("");
  const [nickname, setNickname] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>();
  const [problem, setProblem] = useState<string>();
  // Set at once, so a second click before React renders `busy` does not start a second Agent.
  const starting = useRef(false);
  const folderInput = useRef<HTMLInputElement>(null);

  const modes = host ? PERMISSION_MODES.filter((m) => permissionModeWithin(m, host.maxPermissionMode)) : [];
  const chosenMode = mode && modes.includes(mode) ? mode : modes.includes(DEFAULT_PERMISSION_MODE) ? DEFAULT_PERMISSION_MODE : modes.at(-1);
  const folder = cwd ?? host?.roots[0] ?? "";

  // A long path shows its end, the part that names the repo, unless the Person is editing it.
  useEffect(() => {
    const input = folderInput.current;
    if (input && document.activeElement !== input) input.scrollLeft = input.scrollWidth;
  }, [folder]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!host || !chosenMode || starting.current) return;
    if (!folder.trim().startsWith("/")) return setProblem("The folder must be an absolute path on the Host.");
    starting.current = true;
    setBusy(true);
    setProblem(undefined);
    const result = await store.source.spawnAgent({
      host: host.name,
      cli: "claude-code",
      cwd: folder.trim(),
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

  if (loaded === null) {
    return (
      <DialogHeader>
        <DialogTitle>Start an Agent</DialogTitle>
        <DialogDescription>Looking for your Hosts</DialogDescription>
      </DialogHeader>
    );
  }

  if (hosts.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle>Start an Agent</DialogTitle>
          <DialogDescription>
            {loaded.problem ?? "A Host starts Claude Code Agents on one of your machines, with no terminal. You have none on this Channel yet."}
          </DialogDescription>
        </DialogHeader>
        <p className="text-body text-ink-2">Install one on the machine, naming the folders its Agents may work in:</p>
        <code className="block rounded-md bg-inset px-3 py-2 font-mono text-small text-ink [overflow-wrap:anywhere]">
          switchboard host install --root ~/code/your-repo
        </code>
        <DialogFooter>
          <Button type="button" size="sm" onClick={onDone}>
            Close
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Start an Agent</DialogTitle>
        <DialogDescription>Claude Code, on one of your Hosts. It joins the Channel like any other Agent.</DialogDescription>
      </DialogHeader>
      {hosts.length > 1 && (
        <Field label="Host">
          <select
            value={host?.name}
            onChange={(e) => {
              setChosenHost(e.target.value);
              // Another Host has other folders.
              setCwd(undefined);
            }}
            className={FIELD}
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
      <Field label="Folder" hint={host && <FolderChoices host={host} value={folder} onPick={setCwd} />}>
        <input
          ref={folderInput}
          name="cwd"
          value={folder}
          onChange={(e) => setCwd(e.target.value)}
          spellCheck={false}
          className={`${FIELD} font-mono` /* taste-skill-ignore: a path is code */}
        />
      </Field>
      <Field label="Brief" optional hint="Its first prompt, sent as your Directive.">
        <textarea
          name="brief"
          rows={4}
          autoFocus
          maxLength={MAX_BRIEF_LENGTH}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="Fix the login redirect, then open a PR."
          className="resize-none rounded-md border border-line-strong bg-field px-3 py-2 text-body text-ink outline-none placeholder:text-ink-3 focus-visible:border-accent max-md:text-[16px]"
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
        <select name="permissionMode" value={chosenMode} onChange={(e) => setMode(e.target.value as PermissionMode)} className={FIELD}>
          {modes.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>
      {host && !host.live && (
        <p className="text-small text-ink-2">
          {host.name} is Offline. Start <code className="font-mono text-ink">switchboard host run</code> there, or wait for it to come back.
        </p>
      )}
      {problem && (
        <p role="alert" className="text-small text-red">
          <WithCode text={problem} />
        </p>
      )}
      <DialogFooter>
        <Button type="button" size="sm" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="action" size="sm" disabled={busy || !host?.live}>
          {busy ? "Starting" : "Start Agent"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The Host's folders, any of which (or a folder under one) an Agent may start in: one
 * click puts it in the field. Long paths keep their end, the part that names the repo.
 */
function FolderChoices({ host, value, onPick }: { host: Host; value: string; onPick: (root: string) => void }) {
  return (
    <span className="flex min-w-0 flex-col gap-1.5">
      <span>On {host.name}, in one of its folders or under it:</span>
      <span className="flex min-w-0 flex-wrap gap-1.5">
        {host.roots.map((root) => (
          <button
            key={root}
            type="button"
            title={root}
            onClick={() => onPick(root)}
            aria-pressed={value === root}
            className="block h-7 max-w-full truncate rounded-sm bg-hover px-2 text-small text-ink-2 transition-colors [direction:rtl] hover:bg-hover-2 hover:text-ink aria-pressed:bg-hover-2 aria-pressed:text-ink"
          >
            <code className="font-mono">
              <bdi>{root}</bdi>
            </code>
          </button>
        ))}
      </span>
    </span>
  );
}

/** Stop an Agent one of this Person's Hosts runs: its session ends and it goes Gone. */
export function StopAgentButton({ agent }: { agent: Agent }) {
  const store = useStore();
  const me = useMe();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const asking = useRef(false);
  // Asked to stop: the Presence it had then. Stop stays off until the Host's answer changes it.
  const [stoppingFrom, setStoppingFrom] = useState<Presence | null>(null);
  const stopping = stoppingFrom !== null && stoppingFrom === agent.presence;
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
    setStoppingFrom(agent.presence);
    toast.success(`Asked ${hostName(agent.host ?? "")} to stop ${name}`);
  };

  return (
    <>
      <Button size="sm" disabled={stopping} onClick={() => setConfirming(true)} className="gap-1.5">
        <Square className="size-3 fill-current" aria-hidden /> <span>{stopping ? "Stopping" : "Stop"}</span>
      </Button>
      <Dialog open={confirming} onOpenChange={(next) => (busy && !next ? undefined : setConfirming(next))}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Stop {name}?</DialogTitle>
            <DialogDescription>
              {hostName(agent.host)} ends its Claude Code session. Any Claim it holds goes Stale, for someone to take over.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button type="button" variant="primary" size="sm" disabled={busy} onClick={stop}>
              {busy ? "Stopping" : "Stop Agent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
