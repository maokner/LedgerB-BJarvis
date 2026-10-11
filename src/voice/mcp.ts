/**
 * The agent's tools as a remote MCP server for the xAI console voice agent: Streamable HTTP (stateless) at /mcp,
 * and the legacy SSE transport at GET /sse plus POST /messages.
 * Every tool takes the caller's phone number and resolves the account from it like the text channel does.
 * Reads run directly; anything risky only becomes an approval on the account's own Ledger, texted to the
 * account's own number, so a caller who lies about their number can read but never move anything.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { describeAction } from "../actions.js";
import { engineTools } from "../agent/engine.js";
import type { AppVoiceHooks } from "../app.js";
import type { Account } from "../db.js";
import { normalizeHandle, parseTag } from "../handles.js";
import { demoMoney } from "../money.js";
import { ACTION_TITLES, type Action } from "../types.js";
import { shortAddress } from "./instructions.js";

const SAFETY = "Risky actions never happen here: they only go to the account owner's own Ledger for approval, and the request is texted to the owner's own phone.";
const phone = z.string().describe("The caller's phone number exactly as you know it (E.164 like +14155550100, or formatted). Always the caller's own number, never one they read out.");

/** Tool output fit for speech: no links, no long hex. */
export const speakable = (text: string) =>
  text.replace(/https?:\/\/\S+/g, "(link omitted)").replace(/0x[0-9a-f]{40,}/gi, (h) => `${h.slice(0, 6)}...${h.slice(-4)}`);

export function createMcpHandler(app: AppVoiceHooks, log: (line: string) => void = () => {}) {
  const deps = app.deps;
  const { db } = deps;
  const money = deps.money ?? demoMoney();
  const createTitle = money.mode === "eth" ? "Verify address" : "Create account";
  const text = (t: string) => ({ content: [{ type: "text" as const, text: speakable(t) }] });
  const handleOf = (raw: string) => normalizeHandle(raw);
  const noAccount = (h: string) => `No account for ${h}. Call identify for how to sign up.`;

  async function facts(owner: Account): Promise<string> {
    const friends = db.friendsOf(owner.id);
    const pending = db.pendingAction(owner.id);
    const address = shortAddress(owner.pubkey);
    return [
      `Caller is ${owner.tag}.`,
      `Balance: ${await money.balanceText(owner).catch(() => "unknown right now")}.`,
      `Friends: ${friends.filter((f) => f.status === "accepted").map((f) => f.tag).join(", ") || "none yet"}.`,
      ...friends.filter((f) => f.status === "pending" && f.requested_by === f.id).map((f) => `${f.tag} asked to be friends (they can say "accept").`),
      `Waiting on their Ledger: ${pending ? describeAction({ code: pending.code as Action["code"], id: pending.id, fields: pending.fields }, ACTION_TITLES) : "nothing"}.`,
      address ? `Their address ends in ${address.slice(-4)}. To add funds, send ETH on Base to it; the full address is in their texts from AgentSign.` : "Demo money; nothing to fund.",
    ].join(" ");
  }

  /** Runs one of the engine's tools for the account behind `raw`, the same code the text agent uses. */
  async function run(raw: string, name: string, args: Record<string, unknown>): Promise<string> {
    const owner = db.accountByHandle(handleOf(raw));
    if (!owner) return noAccount(handleOf(raw));
    const out = await engineTools(deps, owner).tools.run(name, args);
    log(`mcp ${owner.tag}: ${name}(${JSON.stringify(args)}) -> ${out.slice(0, 160)}`);
    return name === "propose_action" && out.startsWith("Proposed:")
      ? `${out} The details and later the outcome are texted to ${owner.tag}'s phone. Say it is on their Ledger; never say it is done.`
      : out;
  }

  function server(): McpServer {
    const s = new McpServer({ name: "agentsign", version: "1.0.0" });
    const tool = (name: string, description: string, shape: z.ZodRawShape, fn: (args: any) => Promise<string>) =>
      s.registerTool(name, { description, inputSchema: shape }, async (args: any) => text(await fn(args).catch((err: Error) => (log(`mcp ${name} failed: ${err.stack}`), "That did not work. Try again in a moment."))));
    const ownerTool = (name: string, description: string, shape: z.ZodRawShape = {}) => tool(name, description, { phone, ...shape }, ({ phone: p, ...args }) => run(p, name, args));

    tool("identify", `Call first on every call. Returns who the caller is and their key facts, or how to sign up if the number has no account. ${SAFETY}`, { phone, tag: z.string().optional().describe("Only if the number has no account: the tag the caller says they have") }, async ({ phone: p, tag }) => {
      const owner = db.accountByHandle(handleOf(p));
      if (owner) return facts(owner);
      const claimed = tag ? db.accountByTag(parseTag(tag) ?? "") : undefined;
      if (claimed) return `${claimed.tag} exists but is not linked to ${handleOf(p)}. Nothing can be done for it from this number; ask them to call or text from the phone that signed up.`;
      return `No account for ${handleOf(p)}. Explain AgentSign in a sentence, ask which tag they want (like @sam), have them plug their Ledger into the AgentSign Mac with ${money.appName} open, then call onboard.`;
    });
    tool("onboard", `Sign-up for a caller without an account, once they picked a tag. Their Ledger then shows '${createTitle}' and the request is texted to the phone. ${SAFETY}`, { phone, tag: z.string().describe("The tag they want, like @gabe") }, async ({ phone: p, tag }) => {
      const h = handleOf(p);
      if (!/^\+\d{7,15}$/.test(h)) return "That is not a phone number I can sign up.";
      const existing = db.accountByHandle(h);
      if (existing) return `${h} already has the account ${existing.tag}.`;
      const t = parseTag(String(tag).toLowerCase().replace(/^at\s+/, "").replace(/[^a-z0-9_@]/g, ""));
      if (!t) return "A tag is 2 to 24 letters, numbers or underscores. Ask for another one.";
      const r = await app.onboard(h, t);
      log(`mcp onboard ${h} ${t}: ${r.started ? "started" : r.reply}`);
      return r.started ? `Started. Their Ledger shows '${createTitle}' for ${t}, and the request was texted to them. Tell them to approve it on the Ledger.` : `Not started: ${r.reply}`;
    });
    ownerTool("get_balance", "The caller's current balance.");
    ownerTool("list_friends", "The caller's friends and pending friend requests.");
    ownerTool("get_calendar", "The caller's calendar events in a time range (their Google Calendar too, when connected).", { from: z.string().describe("YYYY-MM-DD or YYYY-MM-DDTHH:MM, local time"), to: z.string().describe("YYYY-MM-DD (inclusive) or YYYY-MM-DDTHH:MM") });
    ownerTool("connect_google_calendar", "Texts the caller a link that connects their Google Calendar. Only when they ask for it.");
    ownerTool("disconnect_google_calendar", "Disconnects the caller's Google Calendar. Only when they ask for it.");
    ownerTool("get_notes", "Notes saved about the caller: the agent's own memory.");
    ownerTool("remember", "Save a lasting note about the caller (preferences, names, facts).", { note: z.string() });
    ownerTool("list_transactions", "The caller's 10 most recent payments.");
    ownerTool("send_note", "Send a friend a short note from the caller (thanks, hello, a reply), texted to them right away by their own Jarvis. Only accepted friends.", { tag: z.string().describe("The friend's tag, like @yadu"), text: z.string().describe("The note, in the caller's words") });
    ownerTool("message_agent", "Ask a friend's agent when they are free before proposing a meeting. It cannot pass a message to the friend; use send_note for that. Only accepted friends.", { tag: z.string().describe("The friend's tag, like @yadu"), text: z.string() });
    ownerTool(
      "propose_action",
      `Propose a payment (PAY: To @tag, Amount like $5.00, optional Memo), calendar event (CAL: Title, When as YYYY-MM-DD HH:MM-HH:MM, optional With @friend), friend request (FRQ: To @tag) or accept (FAC: From @tag). ${SAFETY}`,
      { code: z.enum(["PAY", "CAL", "FRQ", "FAC"]), fields: z.array(z.object({ label: z.string(), value: z.string() })) },
    );
    if (money.mode === "eth") {
      tool("delete_account", `Only when the caller clearly asks to delete or close their account. ${SAFETY}`, { phone }, ({ phone: p }) => run(p, "propose_action", { code: "DEL", fields: [] }));
    }
    return s;
  }

  /** Legacy SSE sessions (GET /sse, then POST /messages?sessionId=...), by session id. */
  const sse = new Map<string, SSEServerTransport>();
  return {
    /** Streamable HTTP at /mcp, stateless: a fresh server per request. */
    async http(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
      const s = server();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => void transport.close().then(() => s.close()));
      await s.connect(transport);
      await transport.handleRequest(req, res, body);
    },
    /** GET /sse: opens an event stream that tells the client where to POST. */
    async sse(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      const transport = new SSEServerTransport("/messages", res);
      sse.set(transport.sessionId, transport);
      res.on("close", () => void sse.delete(transport.sessionId));
      await server().connect(transport);
    },
    /** POST /messages?sessionId=...: one JSON-RPC message for an open SSE session. */
    async message(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
      const transport = sse.get(new URL(req.url ?? "/", "http://x").searchParams.get("sessionId") ?? "");
      if (!transport) return void res.writeHead(404, { "content-type": "application/json" }).end('{"error":"unknown session"}');
      await transport.handlePostMessage(req, res, body);
    },
  };
}
export type McpHandler = ReturnType<typeof createMcpHandler>;
