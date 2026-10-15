/** The last row of a history that has older Events: loads the next page of them. */
export function OlderRow({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  return (
    <li className="flex h-9 items-center justify-center text-[12px] text-ink-3" aria-live="polite">
      {loading ? (
        "Loading older Events"
      ) : (
        <button type="button" onClick={onClick} className="hover:text-ink-2 hover:underline">
          Show older Events
        </button>
      )}
    </li>
  );
}
