/** The remote MCP server for the console voice agent, driven by the SDK's own client over HTTP. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteDeviceManager } from "../src/device/index.js";
import { createMcpHandler, speakable } from "../src/voice/mcp.js";
import { voiceRoutes } from "../src/voice/routes.js";
import { startWebServer, type WebServer } from "../src/web/server.js";
import { harness, PHONES } from "./helpers.js";

const TOKEN = "test-mcp-token";
let web: WebServer | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await web?.close();
});

async function setup(devices = 2) {
  const h = harness(devices);
  web = await startWebServer({ db: h.db, remote: createRemoteDeviceManager({ db: h.db, publicUrl: "http://x" }), port: 0, routes: voiceRoutes({ mcp: createMcpHandler(h.app), mcpToken: TOKEN }) });
  const url = new URL(`http://127.0.0.1:${web.port}/mcp`);
  client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = (await client!.callTool({ name, arguments: args })) as { content: { text: string }[] };
    return res.content[0]!.text;
  };
  return { h, url, call };
}

describe("MCP server", () => {
  it("refuses requests without the token", async () => {
    const { url } = await setup();
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    expect(res.status).toBe(401);
  });

  it("lists the tools, identifies the caller by phone and only proposes payments", async () => {
    const { h, call } = await setup();
    await h.onboard("matt", 0);
    await h.onboard("yadu", 1);
    const names = (await client!.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["identify", "onboard", "get_balance", "list_friends", "get_calendar", "get_notes", "remember", "list_transactions", "send_note", "message_agent", "propose_action"]));
    expect(await call("identify", { phone: "(415) 555-0001" })).toMatch(/^Caller is @matt\. Balance: \$250\.00.*Waiting on their Ledger: nothing/);
    expect(await call("identify", { phone: "+14155559999", tag: "@matt" })).toContain("@matt exists but is not linked to +14155559999");
    expect(await call("identify", { phone: "+14155559999" })).toContain("No account for +14155559999");
    expect(await call("get_balance", { phone: "+14155559999" })).toContain("No account");
    expect(await call("remember", { phone: PHONES.matt, note: "Likes oat milk" })).toBe("Saved.");
    expect(await call("get_notes", { phone: PHONES.matt })).toContain("oat milk");
    const proposed = await call("propose_action", { phone: PHONES.matt, code: "PAY", fields: [{ label: "To", value: "@yadu" }, { label: "Amount", value: "$2.00" }] });
    expect(proposed).toMatch(/^Proposed: Send money: To @yadu, Amount \$2\.00\..*never say it is done/);
    await h.app.whenIdle();
    expect(h.to(PHONES.matt)).toContain("Please confirm on your Ledger: Send money: To @yadu, Amount $2.00");
    expect(h.devices[0]!.shown.at(-1)!.code).toBe("PAY");
    expect(h.db.accountByTag("@yadu")!.balance_cents).toBe(25_200);
  });

  it("starts onboarding for an unknown phone", async () => {
    const { h, call } = await setup(1);
    expect(await call("onboard", { phone: "+1 415 555 0042", tag: "at Gabe" })).toMatch(/^Started\. Their Ledger shows 'Create account' for @gabe/);
    await h.app.whenIdle();
    expect(h.db.accountByHandle("+14155550042")?.tag).toBe("@gabe");
    expect(await call("onboard", { phone: "+14155550042", tag: "@other" })).toContain("already has the account @gabe");
  });

  it("also speaks the legacy SSE transport (GET /sse, POST /messages) with the same token", async () => {
    const { h } = await setup();
    await h.onboard("matt", 0);
    const sseUrl = new URL(`http://127.0.0.1:${web!.port}/sse`);
    expect((await fetch(sseUrl)).status).toBe(401);
    const auth = { authorization: `Bearer ${TOKEN}` };
    const sse = new Client({ name: "sse-test", version: "1" });
    await sse.connect(new SSEClientTransport(sseUrl, { requestInit: { headers: auth }, fetch: (url, init) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...auth } }) }));
    try {
      expect((await sse.listTools()).tools.map((t) => t.name)).toContain("identify");
      const res = (await sse.callTool({ name: "identify", arguments: { phone: PHONES.matt } })) as { content: { text: string }[] };
      expect(res.content[0]!.text).toMatch(/^Caller is @matt\./);
    } finally {
      await sse.close();
    }
  });

  it("keeps results speakable", () => {
    expect(speakable(`Sent to 0x${"ab".repeat(20)}, see https://basescan.org/tx/0x${"cd".repeat(32)}`)).toBe("Sent to 0xabab...abab, see (link omitted)");
  });
});
