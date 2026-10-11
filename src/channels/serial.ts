/**
 * One queue per key (a sender's handle): tasks with the same key run one at a time in the order queued,
 * tasks with different keys run concurrently. A failed task does not stop its queue.
 */
export function keyedQueue(): <T>(key: string, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

/** Splits a long text into chunks of at most `max` characters, preferring line and word breaks. */
export function splitText(text: string, max = 1500): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    // Never cut a surrogate pair (emoji) in half.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
