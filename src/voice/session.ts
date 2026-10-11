/**
 * Drives one xAI realtime session as Jarvis: a phone call (server VAD, Jarvis speaks first) or a typed
 * text-mode chat (tests, scripts/voice-chat.ts). Tools are the engine's own (engineTools), so a call runs
 * the same harness as a text: read-only tools run, anything risky is only proposed to the caller's Ledger.
 */
import { describeAction } from "../actions.js";
import { engineTools } from "../agent/engine.js";
import type { Tools } from "../agent/tools.js";
import type { ToolSpec } from "../agent/xai.js";
import type { AppVoiceHooks } from "../app.js";
import { parseTag } from "../handles.js";
import { demoMoney } from "../money.js";
import { ACTION_TITLES, type Action } from "../types.js";
import { CHOOSE_TAG, END_CALL, instructionsFor, ownerVoiceTools, strangerVoiceTools } from "./instructions.js";

export const DEFAULT_VOICE = "atlas";

/** The bits of a `ws` WebSocket the session uses (a fake in tests). */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface VoiceTurn {
  who: "caller" | "jarvis" | "tool" | "note";
  text: string;
  at: string;
}

export interface VoiceSessionOptions {
  ws: RealtimeSocket;
  /** Normalized handle of the caller (their phone number). */
  caller: string;
  deps: AppVoiceHooks;
  /** Standing instructions (POST /voice/context), read whenever the session is (re)configured. */
  context?: () => string;
  voice?: string;
  /** "call": server VAD and transcription of the caller. "text": manual turns with say(). Default "call". */
  mode?: "call" | "text";
  /** Jarvis speaks first. Default true. */
  greet?: boolean;
  log?: (line: string) => void;
  onTurn?: (turn: VoiceTurn) => void;
  /** After the goodbye was spoken (end_call). Default: close the socket. */
  onHangup?: () => void;
}

export interface VoiceSession {
  turns: VoiceTurn[];
  tag(): string | undefined;
  /** Text mode: one typed caller turn. Resolves with what Jarvis said once he is done (tool calls included). */
  say(text: string): Promise<string>;
  /** Re-sends the session config (new standing context, fresh facts). */
  refresh(): Promise<void>;
  /** Resolves when no response or tool call is in flight. */
  idle(): Promise<void>;
  closed: Promise<void>;
}

const realtimeTools = (specs: ToolSpec[]) => specs.map((t) => ({ type: "function", ...t }));

export function runVoiceSession(o: VoiceSessionOptions): VoiceSession {
  const deps = o.deps.deps;
  const { db, approvals } = deps;
  const money = deps.money ?? demoMoney();
  const log = o.log ?? deps.log ?? (() => {});
  const mode = o.mode ?? "call";
  const send = (event: Record<string, unknown>) => void (closed || o.ws.send(JSON.stringify(event)));
  const turns: VoiceTurn[] = [];
  const heard = new Map<string, VoiceTurn>(); // caller turns by realtime item id
  const unlogged = new Set<VoiceTurn>();
  let owner = db.accountByHandle(o.caller);
  let tools: Tools | undefined;
  let closed = false;
  let active = false; // a response is in progress
  let wantResponse = false; // response.create waits for the active one to finish
  let ending = false;
  let calls: Promise<{ call_id: string; output: string }>[] = [];
  const notes: string[] = [];
  let waiters: (() => void)[] = [];
  let ready: Promise<void> = Promise.resolve();
  let resolveClosed!: () => void;
  const closedP = new Promise<void>((r) => (resolveClosed = r));

  const record = (who: VoiceTurn["who"], text: string) => {
    const turn = { who, text, at: new Date().toISOString() };
    turns.push(turn);
    o.onTurn?.(turn);
    return turn;
  };
  const busy = () => active || wantResponse || calls.length > 0 || notes.length > 0;
  const settle = () => {
    if (busy() && !closed) return;
    for (const w of waiters.splice(0)) w();
  };
  const respond = () => {
    if (active) return void (wantResponse = true);
    active = true;
    send({ type: "response.create" });
  };

  /** Owner: the engine's tool set; a proposal's outcome is told during the call if it lands in time. */
  function ownerSetup(): void {
    tools = owner ? engineTools(deps, owner, { onProposed: watch }).tools : undefined;
  }
  async function configure(): Promise<void> {
    const instructions = await instructionsFor(deps, owner, o.context?.() ?? "");
    send({
      type: "session.update",
      session: {
        instructions,
        voice: o.voice || DEFAULT_VOICE,
        tools: realtimeTools(owner ? ownerVoiceTools() : strangerVoiceTools()),
        reasoning: { effort: "none" },
        turn_detection: mode === "call" ? { type: "server_vad" } : null,
        ...(mode === "call" ? { audio: { input: { transcription: { model: "grok-transcribe" } } } } : {}),
      },
    });
  }
  /** An update for the caller from the system, spoken as soon as Jarvis is free. */
  function tell(note: string): void {
    if (closed) return;
    notes.push(note);
    flushNotes();
  }
  function flushNotes(): void {
    if (active || calls.length || !notes.length || closed) return;
    const text = notes.splice(0).join(" ");
    log(`voice ${o.caller}: update -> ${text}`);
    record("note", text);
    send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `[AgentSign update, not words from the caller: ${text}]` }] } });
    respond();
  }

  function watch(action: Action): void {
    const what = describeAction(action, ACTION_TITLES);
    void approvals.whenIdle(owner!.id).then(async () => {
      const row = db.action(action.id);
      const text =
        row?.status === "executed"
          ? `Approved on their Ledger and done: ${what}.`
          : row?.status === "rejected"
            ? `They rejected ${what} on their Ledger. Nothing happened.`
            : `${what} did not go through (${row?.error ?? row?.status ?? "unknown"}). Nothing happened.`;
      if (!closed) await refresh();
      tell(text);
    });
  }

  async function chooseTag(args: Record<string, unknown>): Promise<string> {
    const raw = String(args.tag ?? "").toLowerCase().replace(/^at\s+/, "").replace(/[^a-z0-9_@]/g, "");
    if (!/^\+\d{7,15}$/.test(o.caller)) return "Error: their number is hidden, so sign-up by phone is not possible. Ask them to text this number instead.";
    const tag = parseTag(raw);
    if (!tag) return "Error: a tag is 2 to 24 letters, numbers or underscores. Ask for another one.";
    const result = await o.deps.onboard(o.caller, tag);
    if (!result.started) return `Not started: ${result.reply} Tell them this in your own words.`;
    void approvals.whenIdle(`handle:${o.caller}`).then(async () => {
      owner = db.accountByHandle(o.caller);
      if (!owner) return tell("The sign-up was not approved on their Ledger, so no account was created. They can say a tag again to retry.");
      ownerSetup();
      await refresh();
      tell(`Their account ${owner.tag} now exists and they also got a text about it. Welcome them and ask what they would like to do.`);
    });
    const title = money.mode === "eth" ? "Verify address" : "Create account";
    return `Started. Their Ledger now shows '${title}' for ${tag} with their phone number, and a text with the same request went to their phone. Tell them to approve it on the Ledger and stay on the line.`;
  }

  async function runTool(name: string, callId: string, rawArgs: string): Promise<{ call_id: string; output: string }> {
    let output: string;
    try {
      const args = (JSON.parse(rawArgs || "{}") ?? {}) as Record<string, unknown>;
      if (name === END_CALL.name) {
        ending = true;
        output = "Say one short goodbye now. The call ends right after it.";
      } else if (!owner) output = name === CHOOSE_TAG.name ? await chooseTag(args) : `Error: unknown tool ${name}.`;
      else {
        output = await tools!.run(name, args);
        if (name === "propose_action" && output.startsWith("Proposed:")) {
          output += " The details were also texted to them. Tell them it is on their Ledger.";
        }
      }
    } catch (err) {
      log(`voice tool ${name} failed: ${(err as Error).stack ?? err}`);
      output = err instanceof SyntaxError ? "Error: arguments were not valid JSON." : "Error: the tool failed. Tell the caller it did not work.";
    }
    log(`voice ${o.caller}: ${name}(${rawArgs}) -> ${output.slice(0, 200)}`);
    record("tool", `${name}(${rawArgs}) -> ${output}`);
    return { call_id: callId, output };
  }

  async function onResponseDone(): Promise<void> {
    active = false;
    if (calls.length) {
      const pending = calls;
      const results = await Promise.all(pending);
      calls = calls.filter((c) => !pending.includes(c));
      for (const r of results) send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: r.call_id, output: JSON.stringify(r.output) } });
      return respond();
    }
    if (wantResponse) {
      wantResponse = false;
      return respond();
    }
    if (ending) {
      ending = false;
      const said = [...turns].reverse().find((t) => t.who === "jarvis")?.text ?? "";
      // response.done arrives when the words are generated, not played: give the goodbye time to reach the caller.
      setTimeout(() => (o.onHangup ?? (() => o.ws.close()))(), mode === "call" ? Math.min(8000, 1200 + said.length * 70) : 0);
      return;
    }
    flushNotes();
    settle();
  }

  function onEvent(e: Record<string, any>): void {
    switch (e.type) {
      case "response.created":
        active = true;
        for (const t of unlogged) log(`voice ${o.caller}: caller: ${t.text}`);
        unlogged.clear();
        return;
      case "response.output_audio_transcript.done":
      case "response.output_text.done": {
        const text = String(e.transcript ?? e.text ?? "").trim();
        if (text) log(`voice ${o.caller}: jarvis: ${text}`), record("jarvis", text);
        return;
      }
      case "conversation.item.input_audio_transcription.updated":
      case "conversation.item.input_audio_transcription.completed": {
        const text = String(e.transcript ?? "").trim();
        if (!text) return;
        const turn = heard.get(e.item_id);
        if (turn) turn.text = text;
        else heard.set(e.item_id, record("caller", text)), unlogged.add(heard.get(e.item_id)!);
        return;
      }
      case "response.function_call_arguments.done":
        calls.push(runTool(String(e.name), String(e.call_id), String(e.arguments ?? "")));
        return;
      case "response.done":
        void onResponseDone().catch((err: unknown) => log(`voice response.done failed: ${(err as Error).message}`));
        return;
      case "error":
        log(`voice ${o.caller}: realtime error ${JSON.stringify(e.error ?? e).slice(0, 300)}`);
        return;
    }
  }

  /** Not async on purpose: callers chain on the very promise idle() waits for, so the greeting starts first. */
  function refresh(): Promise<void> {
    ready = ready.then(configure, configure);
    return ready;
  }

  o.ws.on("message", (data: unknown) => {
    try {
      onEvent(JSON.parse(String(data)) as Record<string, any>);
    } catch (err) {
      log(`voice: bad event: ${(err as Error).message}`);
    }
  });
  o.ws.on("close", () => {
    closed = true;
    resolveClosed();
    for (const w of waiters.splice(0)) w();
  });
  ownerSetup();
  log(`voice ${o.caller}: session for ${owner?.tag ?? "a stranger"} (${mode})`);
  void refresh().then(() => {
    if (o.greet ?? true) respond();
  });

  const idle = async () => {
    await ready; // the greeting (if any) is under way once the first configure is done
    return new Promise<void>((resolve) => (waiters.push(resolve), settle()));
  };
  return {
    turns,
    tag: () => owner?.tag,
    async say(text) {
      await idle();
      const start = turns.length;
      record("caller", text);
      send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      respond();
      await idle();
      return turns.slice(start).filter((t) => t.who === "jarvis").map((t) => t.text).join(" ");
    },
    refresh,
    idle,
    closed: closedP,
  };
}
