import { cn } from "@/lib/utils";

/**
 * The last item of a history list that has older Events: loads the next page of them.
 * `className` lines it up with the list's own text.
 */
export function OlderRow({ loading, onClick, className }: { loading: boolean; onClick: () => void; className?: string }) {
  return (
    <li className={cn("flex min-h-9 items-center py-2 text-small text-ink-3", className)} aria-live="polite">
      {loading ? (
        "Loading older Events"
      ) : (
        <button type="button" onClick={onClick} className="text-accent-ink underline-offset-4 hover:underline">
          Show older Events
        </button>
      )}
    </li>
  );
}
