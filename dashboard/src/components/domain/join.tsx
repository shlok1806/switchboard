import { useState, type FormEvent } from "react";
import { AlertTriangle, Info, Radio } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
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

  const field =
    "h-10 rounded-lg border border-line-strong bg-field px-3 text-[14px] text-ink outline-none transition-colors placeholder:text-ink-4 focus-visible:border-accent max-md:text-[16px]";
  return (
    <TooltipProvider delayDuration={300}>
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-6" noValidate>
        <header className="flex flex-col items-center gap-3 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-accent text-on-accent">
            <Radio className="size-5" aria-hidden />
          </span>
          <h1 className="text-[20px] font-semibold tracking-tight">Join the Channel</h1>
        </header>
        <div className="flex flex-col gap-4 rounded-xl border border-line bg-surface p-5 shadow-card">
          <label className="flex flex-col gap-1.5">
            <span className="flex items-center gap-1.5 text-[13px] font-medium">
              Your name
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="text-ink-4 hover:text-ink-2" aria-label="Name rules">
                    <Info className="size-3.5" aria-hidden />
                  </span>
                </TooltipTrigger>
                <TooltipContent>Lowercase letters, digits, "-" and "_". It starts every Agent ID you run.</TooltipContent>
              </Tooltip>
            </span>
            <input
              id="join-person"
              name="person"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="maya"
              className={`${field} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium">Join secret</span>
            <input
              id="join-secret"
              name="secret"
              type="password"
              autoComplete="current-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className={field}
            />
          </label>
          {problem && (
            <p role="alert" className="flex items-start gap-2 text-[13px] text-red">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {problem}
            </p>
          )}
          <Button type="submit" variant="accent" size="md" disabled={busy} className="w-full">
            {busy ? "Joining" : "Join"}
          </Button>
        </div>
        <p className="text-center text-[12.5px] text-ink-3">Remembered in this browser until you leave.</p>
      </form>
    </main>
    </TooltipProvider>
  );
}
