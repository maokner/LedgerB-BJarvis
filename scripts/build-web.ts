/** Writes the browser bundle for the approval page to dist/ledger.js (the server builds it in memory at start; this is a check). */
import { buildClient } from "../src/web/bundle.js";

console.log(`wrote ${await buildClient("dist/ledger.js")}`);
