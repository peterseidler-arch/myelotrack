/**
 * Failed-attempt limiter for password sign-in. Counts failures per key (the
 * client IP, and separately the email) in a sliding window; once a key hits
 * the limit it is locked until its oldest failure ages out. Success clears the
 * email's count.
 *
 * In-process only: with several Cloud Run instances each keeps its own count,
 * which still caps guessing at limit × instances per window. Good enough for
 * a handful of accounts; move to the database or Redis before opening wider.
 */
export function createAttemptLimiter({ limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const failures = new Map(); // key -> [timestamps]

  const recent = (key, now) => {
    const list = (failures.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  };

  return {
    /** Seconds until any of these keys may try again; 0 when none is locked. */
    retryAfter(keys, now = Date.now()) {
      let wait = 0;
      for (const key of keys) {
        const list = recent(key, now);
        if (list.length >= limit) wait = Math.max(wait, list[0] + windowMs - now);
      }
      return Math.ceil(wait / 1000);
    },
    fail(keys, now = Date.now()) {
      for (const key of keys) failures.set(key, [...recent(key, now), now]);
    },
    clear(key) {
      failures.delete(key);
    },
  };
}
