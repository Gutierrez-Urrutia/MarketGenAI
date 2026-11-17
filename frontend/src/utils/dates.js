/**
 * The one date reader for API values that may arrive in different shapes:
 * ISO text (contact fields saved by the provider), Firestore timestamps
 * (reviewed_at, contacts_search.*) — which the API sends as ISO text, but may
 * also come serialized as {seconds, nanoseconds} / {_seconds, _nanoseconds} —,
 * Date objects, epoch milliseconds, or anything with a toDate() method.
 */

// A Date, or null for a missing or unreadable value. Never throws.
export function toDate(value) {
  if (value === null || value === undefined || value === "") return null;
  let date = null;
  try {
    if (value instanceof Date) {
      date = new Date(value.getTime());
    } else if (typeof value === "string" || typeof value === "number") {
      date = new Date(value);
    } else if (typeof value === "object") {
      if (typeof value.toDate === "function") {
        date = value.toDate();
      } else {
        const seconds = value.seconds ?? value._seconds;
        const nanos = value.nanoseconds ?? value._nanoseconds ?? 0;
        if (typeof seconds === "number") date = new Date(seconds * 1000 + Math.floor(nanos / 1e6));
      }
    }
  } catch {
    return null;
  }
  return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
}

// Localized date and time (no seconds), or `fallback` when there is none.
export function formatDateTime(value, fallback = "—") {
  const date = toDate(value);
  if (!date) return fallback;
  return date.toLocaleString(undefined, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}
