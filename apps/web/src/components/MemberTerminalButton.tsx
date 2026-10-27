/**
 * Roster control that opens one seat's docked PTY.
 * The left column is narrow, so the hit target stays 40px and above any
 * overflowing presence text. Pointer events stop at this button so a parent
 * row handler cannot swallow the click.
 */
export function MemberTerminalButton({
  label,
  onOpen,
}: {
  label: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onPointerDown={(event) => { event.stopPropagation(); }}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-ink-muted transition hover:border-accent/40 hover:text-accent active:scale-[0.98]"
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="pointer-events-none">
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.5" />
        <path d="M4.25 6.25 6.25 8 4.25 9.75M8 10.25h3.5" />
      </svg>
    </button>
  );
}
