/**
 * Exports the operator's DoorDash session for the server (src/food/browser.ts, FOOD_PROVIDER=browser): opens Chromium,
 * lets the operator sign in by hand, and saves the cookies as a Playwright storage state.
 *
 *   pnpm doordash:login                      # writes data/doordash-state.json
 *   pnpm doordash:login path/to/state.json
 *
 * The browser is the one the server runs (Playwright's Chromium, same user agent, locale and time zone), so DoorDash
 * and Cloudflare see the same kind of device on both sides. Run it again whenever the server logs that DoorDash signed
 * it out. The account should hold a saved card and an empty cart: the server checks out whatever card is the default.
 */
import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright";
import { desktopUserAgent } from "../src/amazon/pages.js";
import { DOORDASH, signedIn } from "../src/food/pages.js";

const file = resolve(process.argv[2] ?? "data/doordash-state.json");
const SIGN_IN = `${DOORDASH}/consumer/login/`;

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
try {
  for (;;) {
    await rl.question("Sign in to DoorDash in the window (finish any code it texts you), then press Enter here ");
    await page.goto(`${DOORDASH}/`, { waitUntil: "domcontentloaded" });
    const header = await page.locator("header").first().innerText({ timeout: 15_000 }).catch(() => "");
    if (header && signedIn(header)) break;
    console.log("DoorDash still shows Sign In, so the session is not signed in yet. Finish signing in and press Enter again (Ctrl-C to give up).");
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
Signed in. Saved the DoorDash session to ${file}

This file is as sensitive as the DoorDash password: anyone holding it can order on the account. Never commit or share it.

Before the first real order, try it with DOORDASH_DRY_RUN=1: the server goes all the way to Place Order and stops
(the selectors were written without a signed-in session; data/doordash-shots shows any page they missed).

Give it to the server on Fly (raw JSON also works; base64 keeps the shell from mangling it):

  fly secrets set FOOD_PROVIDER=browser DOORDASH_STORAGE_STATE="$(base64 < ${process.argv[2] ?? "data/doordash-state.json"})" -a agentsign-jarvis
`);
