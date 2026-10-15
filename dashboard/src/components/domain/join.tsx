import { useState, type FormEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { Mark } from "@/components/shell/nav";
import { Button } from "@/components/atoms/Button";

/** GitHub's mark, from Octicons (MIT): `mark-github`, 16px. */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className} fill="currentColor">
      <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
    </svg>
  );
}

/**
 * Sign in to a Channel with GitHub (ADR 0007). A Person is a GitHub account and gets
 * in with write access to the Channel's repo. `problem` says why the last try did not
 * work; `notConfigured` is the reason when the Worker has no GitHub App yet, and
 * turns the button off. `onDevSignIn` is set only under `wrangler dev` with the
 * dev-only fake sign-in.
 */
export function SignInScreen({
  repo,
  problem,
  notConfigured,
  onSignIn,
  onDevSignIn,
}: {
  repo: string;
  problem?: string;
  notConfigured?: string;
  onSignIn: () => void;
  onDevSignIn?: (login: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState("");

  const devSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (login.trim()) onDevSignIn?.(login.trim());
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <header className="flex flex-col items-center gap-3 text-center">
          <Mark className="size-10" />
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-title font-semibold text-ink">Sign in to Switchboard</h1>
            <p className="text-body break-all text-ink-3">{repo}</p>
          </div>
        </header>
        <div className="flex flex-col gap-4 rounded-md bg-panel p-6">
          <p className="text-center text-body leading-relaxed text-ink-2">
            Use a GitHub account with write access to this repo.
          </p>
          {notConfigured ? (
            <p role="status" className="flex items-start gap-2 text-small text-ink-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ink" aria-hidden />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium text-ink">GitHub App not configured</span>
                <span className="break-words text-ink-3">{notConfigured}</span>
              </span>
            </p>
          ) : (
            problem && (
              <p role="alert" className="flex items-start gap-2 text-small text-ink">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                {problem}
              </p>
            )
          )}
          <Button
            type="button"
            variant="action"
            size="md"
            disabled={busy || Boolean(notConfigured)}
            className="w-full"
            onClick={() => {
              setBusy(true);
              onSignIn();
            }}
          >
            <GitHubMark className="size-4" />
            {busy ? "Opening GitHub" : "Sign in with GitHub"}
          </Button>
        </div>
        {onDevSignIn && (
          <form
            onSubmit={devSubmit}
            className="flex flex-col gap-3 rounded-md bg-paper-2 p-4"
            aria-label="Dev sign-in"
          >
            <span className="text-small font-medium text-ink">Dev sign-in, local only</span>
            <div className="flex gap-2">
              <input
                name="login"
                aria-label="GitHub login"
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                placeholder="github-login"
                className="h-9 min-w-0 flex-1 rounded-md border border-line-strong bg-field px-3 text-body text-ink transition-colors placeholder:text-ink-3 max-md:text-[16px]"
              />
              <Button type="submit" variant="secondary" size="md" disabled={!login.trim()}>
                Sign in
              </Button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}

/** At `/`, with no repo in the path: where Channels live. */
export function NoChannelScreen() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-page px-4 py-10">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <Mark className="size-10" />
        <h1 className="text-title font-semibold text-ink">Switchboard</h1>
        <p className="text-body leading-relaxed text-ink-3">
          Each repo has its own Channel. Open it at <code className="font-mono text-ink-2">/owner/repo</code>{/* taste-skill-ignore: a path */}.
        </p>
      </div>
    </main>
  );
}
