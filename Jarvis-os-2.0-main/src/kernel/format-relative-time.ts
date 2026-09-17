// Non-PII disambiguation signal for server.ts's outcomeFollowUpContext —
// live testing showed that with two open outcome_ledger rows for the same
// action_name sharing an identical redacted summary (e.g. two
// "write_file"/"wrote a file" entries), the model has no way to tell them
// apart and can pass the wrong ledgerId even though the mechanism itself
// works. Relative timing gives it something real to reason with without
// reintroducing raw content. Kept in its own module, separate from
// server.ts, for the same reason as outcome-confidence.ts: server.ts calls
// app.listen() unconditionally at import time and must never be imported
// from the test process.
export function formatRelativeTime(date: Date, now: number = Date.now()): string {
  const ms = now - date.getTime();
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "moments ago";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}
