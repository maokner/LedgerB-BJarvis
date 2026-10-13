/**
 * Writes the static site Vercel serves (vercel.json) to dist/site: the account page (index.html, dashboard.js) and the
 * approval page's bundle (ledger.js). The server builds the same bundles in memory at start; this is the deployable copy.
 * API, sign and Google routes stay on the server; vercel.json rewrites them there.
 */
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { buildClient } from "../src/web/bundle.js";
import { dashboardPage } from "../src/web/dashboard.js";

const out = process.argv[2] ?? "dist/site";
mkdirSync(out, { recursive: true });
writeFileSync(`${out}/index.html`, dashboardPage());
console.log(`wrote ${out}/index.html`);
copyFileSync(new URL("../src/web/jarvis.png", import.meta.url), `${out}/jarvis.png`);
console.log(`wrote ${out}/jarvis.png`);
console.log(`wrote ${await buildClient(`${out}/dashboard.js`, "dashboard")}`);
console.log(`wrote ${await buildClient(`${out}/ledger.js`, "ledger")}`);
