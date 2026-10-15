import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Plus, Square } from "lucide-react";
import { toast } from "sonner";
import type { Agent, Host, PermissionMode } from "@shared/index";
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

/** What each permission mode lets the Agent do without asking, in a few words. */
const MODE_HINT: Record<PermissionMode, string> = {
  plan: "reads and plans, changes nothing",
  dontAsk: "runs only tools allowed beforehand",
  default: "asks before edits and commands",
  acceptEdits: "edits files, asks before commands",
  auto: "a classifier approves each action",
  bypassPermissions: "no permission checks",
};

const FIELD =
  "h-10 rounded-md border border-line-strong bg-field px-3 text-body text-ink outline-none placeholder:text-ink-3 focus-visible:border-accent max-md:text-[16px]";

/**
 * This Person's own Hosts (ADR 0015), loaded when asked for. `null` while loading;
 * `hosts` is null when the Channel's Worker has no Hosts at all.
 */
function useMyHosts(load: boolean) {
  const store = useStore();
  const me = useMe();
  const [state, setState] = useState<{ hosts: Host[] | null; problem?: string } | null>(null);
  useEffect(() => {
    if (!load) return;
    let live = true;
    store.source
      .hosts()
      .then((r) => live && setState({ hosts: r === null ? null : r.hosts.filter((h) => h.person === me) }))
      .catch((e: Error) => live && setState({ hosts: [], problem: e.message }));
    return () => {
      live = false;
    };
  }, [store, me, load]);
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
  const store = useStore();
  const [open, setOpen] = useState(false);
  // Asked once up front, so a Channel without Hosts shows no button at all.
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    store.source
      .hosts()
      .then((r) => live && setSupported(r !== null))
      .catch(() => live && setSupported(false));
    return () => {
      live = false;
    };
  }, [store]);

  if (!supported) return null;
  return (
    <>
      <Button variant="action" size="sm" onClick={() => setOpen(true)} className="gap-1">
        <Plus className="size-4" aria-hidden /> <span>Start an Agent</span>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">{open && <StartAgentForm onDone={() => setOpen(false)} />}</DialogContent>
      </Dialog>
    </>
  );
}

function StartAgentForm({ onDone }: { onDone: () => void }) {
  const store = useStore();
  const loaded = useMyHosts(true);
  const hosts = loaded?.hosts ?? [];
  const [hostName, setHostName] = useState<string>();
  const host = hosts.find((h) => h.name === hostName) ?? hosts.find((h) => h.live) ?? hosts[0];
  const [cwd, setCwd] = useState<string>();
  const [brief, setBrief] = useState("");
  const [nickname, setNickname] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  const modes = host ? PERMISSION_MODES.filter((m) => permissionModeWithin(m, host.maxPermissionMode)) : [];
  const chosenMode = mode && modes.includes(mode) ? mode : modes.includes(DEFAULT_PERMISSION_MODE) ? DEFAULT_PERMISSION_MODE : modes.at(-1);
  const folder = cwd ?? host?.roots[0] ?? "";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!host || !chosenMode) return;
    if (!folder.trim().startsWith("/")) return setProblem("The folder must be an absolute path on the Host.");
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
    setBusy(false);
    if (!result.ok) return setProblem(result.reason);
    const { agent } = result.answer;
    onDone();
    if (agent) {
      toast.success(`${agent.nickname ?? agent.id} is running on ${result.answer.host}`);
      go({ view: "agent", id: agent.id });
    } else {
      toast(`${result.answer.host} is still starting it. It appears here once it is on the Channel.`);
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
          <select value={host?.name} onChange={(e) => setHostName(e.target.value)} className={FIELD}>
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
        <input name="cwd" value={folder} onChange={(e) => setCwd(e.target.value)} spellCheck={false} className={`${FIELD} font-mono`} />
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
        <select value={chosenMode} onChange={(e) => setMode(e.target.value as PermissionMode)} className={FIELD}>
          {modes.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>
      {host && !host.live && (
        <p className="text-small text-ink-2">{host.id} is Offline: start `switchboard host run` there, or wait for it to come back.</p>
      )}
      {problem && (
        <p role="alert" className="text-small text-red">
          {problem}
        </p>
      )}
      <DialogFooter>
        <Button type="button" size="sm" onClick={onDone}>
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
      <span>
        On {host.id}, in one of its folders or under it:
      </span>
      <span className="flex min-w-0 flex-wrap gap-1.5">
        {host.roots.map((root) => (
          <button
            key={root}
            type="button"
            title={root}
            onClick={() => onPick(root)}
            aria-pressed={value === root}
            className="block h-7 max-w-full truncate rounded-sm bg-inset px-2 font-mono text-small text-ink-2 transition-colors [direction:rtl] hover:bg-hover hover:text-ink aria-pressed:bg-hover-2 aria-pressed:text-ink"
          >
            <bdi>{root}</bdi>
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
  if (agent.host === undefined || agent.person !== me || agent.presence === "gone") return null;

  const stop = async () => {
    setBusy(true);
    const result = await store.source.stopAgent(agent.id);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) toast.error(result.reason);
    else toast.success(`Asked ${agent.host} to stop ${agent.nickname ?? agent.id}`);
  };

  return (
    <>
      <Button size="sm" onClick={() => setConfirming(true)} className="gap-1.5">
        <Square className="size-3 fill-current" aria-hidden /> <span>Stop</span>
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Stop {agent.nickname ?? agent.id}?</DialogTitle>
            <DialogDescription>
              {agent.host} ends its Claude Code session. Any Claim it holds goes Stale, for someone to take over.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" size="sm" onClick={() => setConfirming(false)}>
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
