/** Bundles src/web/ledger-client.ts (WebHID transport, hw-app-eth, ethers) for the browser with esbuild. */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));

/** How the page's code is bundled for the browser (also used by test/ledger-app.test.ts to run the same code in Node). */
export const BROWSER_BUILD = {
  bundle: true,
  platform: "browser",
  target: "chrome110",
  inject: [here("./buffer-shim.ts")],
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  logLevel: "silent",
} as const;

/** The minified browser bundle. Takes a second or two; the server builds it once at start. */
export async function buildClient(outfile?: string): Promise<string> {
  const result = await build({
    ...BROWSER_BUILD,
    inject: [...BROWSER_BUILD.inject],
    entryPoints: [here("./ledger-client.ts")],
    format: "iife",
    minify: true,
    legalComments: "none",
    write: Boolean(outfile),
    outfile: outfile ?? "ledger.js",
  });
  return outfile ? outfile : result.outputFiles![0]!.text;
}
