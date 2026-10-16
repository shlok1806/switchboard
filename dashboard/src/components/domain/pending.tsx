import { buttonVariants } from "@/components/atoms/Button";
import { CAPABILITY_ISSUE, type Capabilities } from "@/data/source";

const REPO_ISSUES = "https://github.com/shlok1806/switchboard/issues/";

/** Links the issue that will bring a missing capability, inside a sentence: `#14`. */
export function IssueLink({ capability }: { capability: keyof Capabilities }) {
  const n = CAPABILITY_ISSUE[capability];
  return (
    <a href={`${REPO_ISSUES}${n}`} target="_blank" rel="noreferrer" className="text-ink tabular-nums underline-offset-4 hover:underline">
      #{n}
    </a>
  );
}

/** The same issue as an empty state's one action: a link that looks like a button. */
export function IssueButton({ capability, label }: { capability: keyof Capabilities; label: string }) {
  const n = CAPABILITY_ISSUE[capability];
  return (
    <a href={`${REPO_ISSUES}${n}`} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary" })}>
      {label} <span className="text-ink-3 tabular-nums">#{n}</span>
    </a>
  );
}
