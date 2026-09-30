import { useState, type FormEvent } from "react";
import { PixelIcon } from "@/components/pixel-icon";
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

  // The X login box: one Motif dialog in the middle of the stippled root window.
  const field =
    "bevel-in h-8 bg-card px-2 font-mono text-[13px] text-card-foreground outline-none placeholder:text-faint focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[hsl(var(--ring))] coarse:h-11 coarse:text-[16px]";
  return (
    <main className="stipple flex min-h-dvh items-center justify-center px-3 py-10">
      <form onSubmit={submit} className="bevel-out w-full max-w-md bg-secondary text-secondary-foreground" noValidate>
        <header className="titlebar-active flex h-[26px] items-center gap-1.5 px-1.5 coarse:h-11">
          <PixelIcon name="terminal" />
          <h1 className="text-[13px] leading-none font-bold tracking-tight">Switchboard: Join the Channel</h1>
        </header>
        <div className="bevel-in m-[3px] mt-0 flex flex-col gap-4 bg-card px-4 py-4 text-card-foreground">
          <p className="text-[13px] leading-relaxed text-ink-2">
            Everyone on the Channel sees every Event, Task and Claim. Use the join secret your group shares and the name
            your Agents run under.
          </p>
          <div className="grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-[7rem_minmax(0,1fr)] sm:items-center">
            <label htmlFor="join-person" className="text-[13px] font-semibold">
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
              className={field}
            />
            <span id="join-person-hint" className="text-[11.5px] text-ink-3 sm:col-start-2">
              Lowercase letters, digits, "-" and "_". It starts every Agent ID you run.
            </span>
            <label htmlFor="join-secret" className="mt-2 text-[13px] font-semibold sm:mt-0">
              Join secret
            </label>
            <input
              id="join-secret"
              name="secret"
              type="password"
              autoComplete="current-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className={field}
            />
          </div>
          {problem && (
            <p role="alert" className="flex items-start gap-2 text-[12.5px] font-semibold text-red">
              <PixelIcon name="alert" className="mt-px" />
              {problem}
            </p>
          )}
        </div>
        <footer className="flex items-center justify-between gap-3 px-2 pt-1 pb-2">
          <p className="text-[11.5px] text-muted-foreground">This browser remembers both until you leave the Channel.</p>
          <Button type="submit" variant="accent" size="sm" disabled={busy} className="shrink-0 px-5 coarse:h-11">
            {busy ? "Joining" : "Join"}
          </Button>
        </footer>
      </form>
    </main>
  );
}
