// Date formatting that cannot print "Invalid Date".
//
// Rooms created before the server started stamping `time` still hold messages
// with no usable timestamp, and `new Date(undefined).toLocaleTimeString()`
// renders as the literal string "Invalid Date" next to the sender's name.
// Every message-time formatter in the app goes through here instead.

/** Stand-in shown when a stored time cannot be turned into a date. */
export const INVALID_TIME_PLACEHOLDER = '—';

export function safeFormatTime(
  value: number | Date | null | undefined,
  format: (date: Date) => string,
): string {
  // Deliberately not `new Date(value)`: that turns null into the epoch, so a
  // message stored with `time: null` would render as a confident 1970 rather
  // than as "we don't know".
  const date = value instanceof Date
    ? value
    : typeof value === 'number' && Number.isFinite(value) ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return INVALID_TIME_PLACEHOLDER;
  return format(date);
}
