import type { ReactNode } from "react";
import { CAPABILITY_ISSUE, type Capabilities } from "@/data/source";

const REPO_ISSUES = "https://github.com/shlok1806/switchboard/issues/";

/** Links the issue that will bring a missing capability. */
export function IssueLink({ capability }: { capability: keyof Capabilities }) {
  const n = CAPABILITY_ISSUE[capability];
  return (
    <a href={`${REPO_ISSUES}${n}`} target="_blank" rel="noreferrer" className="font-mono text-accent-ink hover:underline">
      #{n}
    </a>
  );
}

/** A calm empty state for a part of the Dashboard the Channel does not serve yet. */
export function Pending({ title, children, className = "" }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center ${className}`}>
      <p className="text-[13.5px] font-medium text-ink">{title}</p>
      <p className="max-w-sm text-[12.5px] leading-relaxed text-ink-3">{children}</p>
    </div>
  );
}
