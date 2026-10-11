/**
 * Texts the agent through a running dev channel (`pnpm dev`) and prints what comes back.
 *
 *   pnpm demo:chat --as +15550000001 'send $5 to @gabriel'
 *   pnpm demo:chat --as yadu accept
 *   pnpm demo:chat --image ./receipt.jpg 'pay gabe back for lunch'
 *
 * Options: --as <handle|matt|yadu> (default Matt), --image <path> (repeatable),
 * --wait <seconds> to keep polling the outbox (default 10), --url (default http://127.0.0.1:$DEV_PORT).
 * Use single quotes around texts containing "$".
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEV_HANDLES, devOutbox, devSend } from "../src/channels/dev.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: "string", default: DEV_HANDLES.matt },
    image: { type: "string", multiple: true, default: [] },
    wait: { type: "string", default: "10" },
    url: { type: "string", default: `http://127.0.0.1:${process.env.DEV_PORT ?? 7777}` },
  },
});

const handle = DEV_HANDLES[values.as.replace(/^@/, "").toLowerCase() as keyof typeof DEV_HANDLES] ?? values.as;
const text = positionals.join(" ");
const images = values.image.map((p) => resolve(p));
if (!text && images.length === 0) {
  console.error("usage: pnpm demo:chat [--as +15550000001|matt|yadu] [--image path] 'text'");
  process.exit(2);
}

console.log(`you (${handle})> ${text}${images.length ? ` [${images.length} image(s)]` : ""}`);
let since: number;
try {
  const res = await devSend(values.url, handle, text, images);
  for (const r of res.replies) console.log(`agent -> ${handle}: ${r}`);
  since = res.since;
} catch (err) {
  if (err instanceof TypeError) {
    const reason = err.cause instanceof Error ? err.cause.message : err.message;
    console.error(`could not reach the dev channel at ${values.url} (${reason}). Is \`pnpm dev\` running?`);
  } else {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}

// Approvals finish in the background: show everything the agent sends (to anyone) for a while.
const deadline = Date.now() + Number(values.wait) * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  const page = await devOutbox(values.url, undefined, since);
  for (const m of page.messages) console.log(`agent -> ${m.to}: ${m.text}`);
  since = page.since;
}
