/**
 * Exports the operator's Amazon session for the server (src/amazon/browser.ts): opens Chromium, lets the operator sign
 * in by hand, and saves the cookies as a Playwright storage state.
 *
 *   pnpm amazon:login                      # writes data/amazon-state.json
 *   pnpm amazon:login path/to/state.json
 *
 * The browser is the one the server runs (Playwright's Chromium, same user agent, locale and time zone), so Amazon sees
 * the same kind of device on both sides. Run it again whenever the server logs that Amazon signed it out.
 */
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { AMAZON, desktopUserAgent, signedInName } from "../src/amazon/pages.js";

const file = resolve(process.argv[2] ?? "data/amazon-state.json");
// Amazon's own "Hello, sign in" link: a bare /ap/signin without these parameters shows an error page.
const SIGN_IN =
  `${AMAZON}/ap/signin?openid.pape.max_auth_age=0&openid.return_to=${encodeURIComponent(`${AMAZON}/`)}` +
  "&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=usflex&openid.mode=checkid_setup" +
  "&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0";

const browser = await chromium.launch({ headless: false, channel: "chromium" });
const context = await browser.newContext({
  userAgent: desktopUserAgent(browser.version()),
  viewport: { width: 1440, height: 900 },
  locale: "en-US",
  timezoneId: "America/Los_Angeles",
});
const page = await context.newPage();
await page.goto(SIGN_IN, { waitUntil: "domcontentloaded" });

const rl = createInterface({ input: process.stdin, output: process.stdout });
let name: string | undefined;
try {
  for (;;) {
    await rl.question('Sign in to Amazon in the window (tick "Keep me signed in"), then press Enter here ');
    await page.goto(`${AMAZON}/`, { waitUntil: "domcontentloaded" });
    const greeting = await page.locator("#nav-link-accountList-nav-line-1, #nav-link-accountList").first().innerText({ timeout: 15_000 }).catch(() => "");
    if ((name = signedInName(greeting))) break;
    console.log(`Amazon still says "${greeting.split("\n")[0] || "nothing"}", so the session is not signed in yet. Finish signing in and press Enter again (Ctrl-C to give up).`);
    await page.goto(SIGN_IN, { waitUntil: "domcontentloaded" });
  }
  await mkdir(dirname(file), { recursive: true });
  await context.storageState({ path: file });
  await chmod(file, 0o600);
} finally {
  rl.close();
  await browser.close();
}

console.log(`
Signed in as ${name}. Saved the session to ${file}

This file is as sensitive as the Amazon password: anyone holding it can order on the account. Never commit or share it.

Give it to the server on Fly (raw JSON also works; base64 keeps the shell from mangling it):

  fly secrets set AMAZON_STORAGE_STATE="$(base64 < ${process.argv[2] ?? "data/amazon-state.json"})" -a agentsign-jarvis
`);
