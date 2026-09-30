import { useState, type FormEvent } from "react";
import { Radio } from "@/components/pixel-icon";
import { normalizePersonName, type JoinCredentials } from "@shared/index";
import { Button } from "@/components/atoms/Button";

/**
 * Join the Channel with the shared join secret and a Person name (interim identity, #1).
 * `onJoin` checks them against the Channel and answers with a reason when it refuses.
 */
export function JoinScreen({
  initial,
  error,
  onJoin,
}: {
  initial?: Partial<JoinCredentials>;
  error?: string;
  onJoin: (credentials: JoinCredentials) => Promise<string | null>;
}) {
  const [secret, setSecret] = useState(initial?.secret ?? "");
  const [name, setName] = useState(initial?.person ?? "");
  const [problem, setProblem] = useState<string | undefined>(error);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const person = normalizePersonName(name);
    if (!person) {
      setProblem("Pick a name of 1 to 32 characters: letters, digits, '-' or '_', starting with a letter or digit.");
      return;
    }
    if (!secret) {
      setProblem("Enter the join secret your group shares.");
      return;
    }
    setBusy(true);
    const reason = await onJoin({ secret, person });
    setBusy(false);
    setProblem(reason ?? undefined);
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5" noValidate>
        <header className="flex flex-col gap-3">
          <span className="flex size-10 items-center justify-center rounded-[10px] bg-accent text-on-accent">
            <Radio className="size-5" />
          </span>
          <h1 className="font-display text-[24px] font-semibold leading-tight text-ink">Join the Channel</h1>
          <p className="text-[13.5px] leading-relaxed text-ink-2">
            Everyone on the Channel sees every Event, Task and Claim. Use the join secret your group shares and the name
            your Agents run under.
          </p>
        </header>

        <div className="flex flex-col gap-4 rounded-card bg-surface p-4 shadow-card">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="join-person" className="text-[12.5px] font-medium text-ink">
              Your name
            </label>
            <input
              id="join-person"
              aria-describedby="join-person-hint"
              name="person"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. maya"
              className="h-9 rounded-[6px] border border-line bg-field px-2.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-accent"
            />
            <span id="join-person-hint" className="text-[11.5px] text-ink-3">
              Lowercase letters, digits, "-" and "_". It starts every Agent ID you run.
            </span>
          </div>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12.5px] font-medium text-ink">Join secret</span>
            <input
              name="secret"
              type="password"
              autoComplete="current-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="h-9 rounded-[6px] border border-line bg-field px-2.5 font-mono text-[13px] text-ink outline-none focus:border-accent"
            />
          </label>
          {problem && (
            <p role="alert" className="rounded-[6px] bg-red-tint px-2.5 py-2 text-[12.5px] text-red">
              {problem}
            </p>
          )}
          <Button type="submit" variant="accent" size="md" disabled={busy} className="w-full">
            {busy ? "Joining" : "Join"}
          </Button>
        </div>
        <p className="text-center text-[12px] text-ink-3">This browser remembers both until you leave the Channel.</p>
      </form>
    </main>
  );
}
