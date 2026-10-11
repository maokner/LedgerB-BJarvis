/**
 * USB HID through @ledgerhq/hw-transport-node-hid. The device is opened for one request and closed
 * after it, so two processes (or a Ledger Live window) are not locked out for long.
 *
 * The package only loads through CommonJS in this ESM project, and it is required lazily so that
 * importing src/device never loads the native HID module unless "hid" is configured.
 */
import { createRequire } from "node:module";
import { type Endpoint, type Exchange, splitResponse, withTimeout } from "./apdu.js";

interface HidTransport {
  exchange(apdu: Buffer): Promise<Buffer>;
  close(): Promise<void>;
}

interface HidTransportClass {
  list(): Promise<string[]>;
  open(path: string): Promise<HidTransport>;
}

let hidClass: HidTransportClass | undefined;

function transportClass(): HidTransportClass {
  if (!hidClass) {
    const require = createRequire(import.meta.url);
    hidClass = (require("@ledgerhq/hw-transport-node-hid") as { default: HidTransportClass }).default;
  }
  return hidClass;
}

/** Paths of every connected Ledger HID interface. Never throws. */
export async function listHidPaths(): Promise<string[]> {
  try {
    return await transportClass().list();
  } catch {
    return [];
  }
}

export function hidEndpoint(path: string): Endpoint {
  return {
    id: `hid:${path}`,
    kind: "hid",
    label: "Ledger Nano S Plus (USB)",
    async session<T>(fn: (exchange: Exchange) => Promise<T>, timeoutMs: number): Promise<T> {
      let transport: HidTransport | undefined;
      let done = false;
      const close = () => {
        const t = transport;
        transport = undefined;
        t?.close().catch(() => {});
      };
      const run = async () => {
        const t = await transportClass().open(path);
        if (done) {
          await t.close().catch(() => {});
          throw new Error("timed out while opening");
        }
        transport = t;
        return fn(async (apdu) => splitResponse(await t.exchange(apdu)));
      };
      const stop = () => {
        done = true;
        close();
      };
      try {
        return await withTimeout(run(), timeoutMs, `USB device ${path}`, stop);
      } finally {
        stop();
      }
    },
  };
}
