/**
 * Speculos APDU port: raw TCP, each APDU sent as a 4-byte big-endian length then the bytes; the reply
 * is a 4-byte big-endian length of the data, the data, then the 2-byte status word.
 * One TCP connection per APDU, so a restarted emulator is picked up on the next request.
 */
import { createConnection, type Socket } from "node:net";
import { type ApduResponse, type Endpoint, type Exchange, withTimeout } from "./apdu.js";

export const SPECULOS_CONNECT_TIMEOUT_MS = 1500;

export function speculosEndpoint(host: string, port: number): Endpoint {
  return {
    id: `speculos:${host}:${port}`,
    kind: "speculos",
    label: `Speculos nanosp :${port}`,
    async session<T>(fn: (exchange: Exchange) => Promise<T>, timeoutMs: number): Promise<T> {
      const open = new Set<Socket>();
      const exchange: Exchange = (apdu) => speculosExchange(host, port, apdu, open);
      return withTimeout(fn(exchange), timeoutMs, `Speculos ${host}:${port}`, () => {
        for (const socket of open) socket.destroy();
      });
    },
  };
}

/** Sends one APDU on a fresh connection. Sockets are tracked in `open` so a session timeout can kill them. */
export function speculosExchange(host: string, port: number, apdu: Buffer, open = new Set<Socket>()): Promise<ApduResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    open.add(socket);
    let received = Buffer.alloc(0);
    let settled = false;
    const finish = (error: Error | undefined, response?: ApduResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      open.delete(socket);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const connectTimer = setTimeout(() => finish(new Error(`connect to ${host}:${port} timed out`)), SPECULOS_CONNECT_TIMEOUT_MS);
    socket.on("connect", () => {
      clearTimeout(connectTimer);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(apdu.length);
      socket.write(Buffer.concat([header, apdu]));
    });
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4) return;
      const length = received.readUInt32BE(0);
      if (received.length < 4 + length + 2) return;
      finish(undefined, { data: received.subarray(4, 4 + length), sw: received.readUInt16BE(4 + length) });
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish(new Error(`Speculos ${host}:${port} closed the connection`)));
  });
}
