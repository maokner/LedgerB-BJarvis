/**
 * Drives one realtime session as Jarvis over a websocket: OpenAI's realtime API (GA event shapes, phone calls through
 * Twilio in src/voice/twilio.ts) or xAI's (src/voice/webhook.ts), in call mode (server VAD, Jarvis speaks first) or
 * typed text mode (tests, scripts/voice-chat.ts). Tools are the engine's own (engineTools), so a call runs the same
 * harness as a text: read-only tools run, anything risky is only proposed to the caller's Ledger.
 *
 * Who is calling: the caller's number is looked up as a handle. An account whose channel is Telegram links its
 * number once (src/phone.ts): an unknown caller hears a four-digit code, texts it to Jarvis, and the live call switches
 * to the owner's tools. Without phone links (the older phone-identity setup) an unknown caller signs up by choosing a tag.
 */
import { describeAction } from "../actions.js";
import { engineTools } from "../agent/engine.js";
import type { Tools } from "../agent/tools.js";
import type { ToolSpec } from "../agent/xai.js";
import type { AppVoiceHooks } from "../app.js";
import type { Db } from "../db.js";
import { parseTag } from "../handles.js";
import { demoMoney } from "../money.js";
import type { PhoneLinks } from "../phone.js";
import { ACTION_TITLES, type Action } from "../types.js";
import { chatName, CHOOSE_TAG, END_CALL, instructionsFor, strangerVoiceTools, unlinkedVoiceTools } from "./instructions.js";

export const DEFAULT_VOICE = "atlas";
/** OpenAI voices: alloy, ash, ballad, coral, echo, sage, shimmer, verse, marin, cedar. Cedar is the deeper one. */
export const DEFAULT_OPENAI_VOICE = "cedar";
export type RealtimeProvider = "xai" | "openai";

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
  /** Whose event shapes and session schema. Default "xai". */
  provider?: RealtimeProvider;
  /** "call": server VAD and transcription of the caller. "text": manual turns with say(). Default "call". */
  mode?: "call" | "text";
  /** Jarvis speaks first. Default true. */
  greet?: boolean;
  /** Phone links: unknown callers hear a code instead of signing up by phone. */
  phone?: PhoneLinks;
  log?: (line: string) => void;
  onTurn?: (turn: VoiceTurn) => void;
  /** Call mode: audio from Jarvis (base64, the session's output format) and the assistant item it belongs to. */
  onAudio?: (base64: string, itemId: string) => void;
  /** Call mode: the caller started speaking over Jarvis; the transport stops playback and calls truncate(). */
  onSpeechStarted?: () => void;
  /** After the goodbye was spoken (end_call). Default: close the socket. */
  onHangup?: () => void;
}

export interface VoiceSession {
  turns: VoiceTurn[];
  tag(): string | undefined;
  /** Text mode: one typed caller turn. Resolves with what Jarvis said once he is done (tool calls included). */
  say(text: string): Promise<string>;
  /** Call mode: audio from the caller (base64, the session's input format). */
  appendAudio(base64: string): void;
  /** Call mode, after a barge-in: keeps only what the caller actually heard of Jarvis's last item. */
  truncate(itemId: string, audioEndMs: number): void;
  /** Re-sends the session config (new standing context, fresh facts). */
  refresh(): Promise<void>;
  /** Resolves when no response or tool call is in flight. */
  idle(): Promise<void>;
  close(): void;
  closed: Promise<void>;
}

const realtimeTools = (specs: ToolSpec[]) => specs.map((t) => ({ type: "function", ...t }));

export function runVoiceSession(o: VoiceSessionOptions): VoiceSession {
  const deps = o.deps.deps;
  const { db, approvals } = deps;
  const money = deps.money ?? demoMoney();
  const log = o.log ?? deps.log ?? (() => {});
  const mode = o.mode ?? "call";
  const provider = o.provider ?? "xai";
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
  let configured = false; // OpenAI only takes the voice before the first audio, so it goes out once
  let calls: Promise<{ call_id: string; output: string }>[] = [];
  const notes: string[] = [];
  let waiters: (() => void)[] = [];
  let ready: Promise<void> = Promise.resolve();
  let resolveClosed!: () => void;
  const closedP = new Promise<void>((r) => (resolveClosed = r));
  let unlinkListener: (() => void) | undefined;

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
  const chat = () => chatName(owner ? db.primaryHandle(owner.id) : undefined);

  /** Owner: the engine's tool set; a proposal's outcome is told during the call if it lands in time. */
  function ownerSetup(): void {
    tools = owner ? engineTools(deps, owner, { onProposed: watch }).tools : undefined;
  }
  function toolSpecs(): ToolSpec[] {
    if (owner) return [...tools!.specs, END_CALL];
    return o.phone ? unlinkedVoiceTools() : strangerVoiceTools();
  }
  async function configure(): Promise<void> {
    const code = !owner && o.phone ? o.phone.issue(o.caller) : undefined;
    const instructions = await instructionsFor(deps, owner, o.context?.() ?? "", code);
    const tools = realtimeTools(toolSpecs());
    const voice = o.voice || (provider === "openai" ? DEFAULT_OPENAI_VOICE : DEFAULT_VOICE);
    if (provider === "openai") {
      const call = mode === "call";
      send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions,
          tools,
          tool_choice: "auto",
          output_modalities: [call ? "audio" : "text"],
          audio: {
            input: {
              ...(call ? { format: { type: "audio/pcmu" }, transcription: { model: "gpt-4o-transcribe" }, noise_reduction: { type: "far_field" } } : {}),
              turn_detection: call ? { type: "server_vad", silence_duration_ms: 600, prefix_padding_ms: 300, create_response: true, interrupt_response: true } : null,
            },
            ...(call ? { output: { format: { type: "audio/pcmu" }, ...(configured ? {} : { voice }) } } : {}),
          },
        },
      });
    } else {
      send({
        type: "session.update",
        session: {
          instructions,
          voice,
          tools,
          reasoning: { effort: "none" },
          turn_detection: mode === "call" ? { type: "server_vad" } : null,
          ...(mode === "call" ? { audio: { input: { transcription: { model: "grok-transcribe" } } } } : {}),
        },
      });
    }
    configured = true;
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

  /** The caller's number was linked to an account mid-call (they texted the code): switch to that owner's tools. */
  async function becameOwner(): Promise<void> {
    owner = db.accountByHandle(o.caller);
    if (!owner) return;
    ownerSetup();
    await refresh();
    tell(`Their number is now linked: they are ${owner.tag}. Say it is linked, then ask what they would like to do.`);
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
      } else if (!owner) output = name === CHOOSE_TAG.name && !o.phone ? await chooseTag(args) : `Error: unknown tool ${name}.`;
      else {
        output = await tools!.run(name, args);
        if (name === "propose_action" && output.startsWith("Proposed:")) {
          output += ` The details and the link to sign it went to ${chat()}. Tell them it is on their Ledger.`;
        } else if (name === "connect_google_calendar" && !output.startsWith("Error")) {
          output = `The link to connect Google Calendar went to ${chat()}. Tell them to open it there.`;
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
      case "response.output_audio.delta": // OpenAI (GA)
      case "response.audio.delta": // older shape
        if (typeof e.delta === "string" && e.delta) o.onAudio?.(e.delta, String(e.item_id ?? ""));
        return;
      case "input_audio_buffer.speech_started":
        o.onSpeechStarted?.();
        return;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
      case "response.output_text.done":
      case "response.text.done": {
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
      case "error": {
        const code = String(e.error?.code ?? "");
        log(`voice ${o.caller}: realtime error ${JSON.stringify(e.error ?? e).slice(0, 300)}`);
        // Our response.create raced a VAD-triggered one: ask again once that one is done.
        if (code === "conversation_already_has_active_response") wantResponse = true;
        return;
      }
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
    unlinkListener?.();
    resolveClosed();
    for (const w of waiters.splice(0)) w();
  });
  ownerSetup();
  if (!owner && o.phone) unlinkListener = o.phone.onLinked(o.caller, () => void becameOwner());
  log(`voice ${o.caller}: session for ${owner?.tag ?? (o.phone ? "an unlinked number" : "a stranger")} (${provider}, ${mode})`);
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
    appendAudio: (base64) => send({ type: "input_audio_buffer.append", audio: base64 }),
    truncate: (itemId, audioEndMs) => send({ type: "conversation.item.truncate", item_id: itemId, content_index: 0, audio_end_ms: Math.max(0, Math.round(audioEndMs)) }),
    refresh,
    idle,
    close: () => o.ws.close(),
    closed: closedP,
  };
}

/** The call's words go into the account's chat history, so the text agent knows what was said. */
export function persistCall(db: Db, caller: string, turns: VoiceTurn[], startedAt: string, endedAt: string): void {
  const account = db.accountByHandle(caller);
  const lines = turns.filter((t) => t.who === "caller" || t.who === "jarvis").map((t) => `${t.who === "caller" ? "User" : "Jarvis"} said: ${t.text}`);
  if (!account || !lines.length) return;
  const minutes = Math.max(1, Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 60_000));
  db.addMessage(account.id, "system", { role: "system", content: `Phone call (${minutes} min):\n${lines.join("\n").slice(-3000)}` });
}
