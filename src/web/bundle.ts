/**
 * Bundles the pages' browser code with esbuild: src/web/ledger-client.ts (the approval page, /ledger.js) and
 * src/web/dashboard-client.ts (the account page, /dashboard.js). Both carry the WebHID transport, hw-app-eth and ethers.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/** How the pages' code is bundled for the browser (also used by test/ledger-app.test.ts to run the same code in Node). */
export const BROWSER_BUILD = {
  bundle: true,
  platform: "browser",
  target: "chrome110",
  inject: [here("./buffer-shim.ts")],
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
} as const;

export type Bundle = "ledger" | "dashboard";
const ENTRY: Record<Bundle, string> = { ledger: "./ledger-client.ts", dashboard: "./dashboard-client.ts" };

/** The minified browser bundle. Takes a second or two each; the server builds them once at start. */
export async function buildClient(outfile?: string, which: Bundle = "ledger"): Promise<string> {
  const result = await build({
    ...BROWSER_BUILD,
    inject: [...BROWSER_BUILD.inject],
    entryPoints: [here(ENTRY[which])],
    format: "iife",
    minify: true,
    legalComments: "none",
    write: Boolean(outfile),
    outfile: outfile ?? `${which}.js`,
  });
  return outfile ? outfile : result.outputFiles![0]!.text;
}
