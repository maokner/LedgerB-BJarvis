/** xAI chat completions (OpenAI-compatible) over plain fetch, with tool calling and image input. */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON text exactly as the model produced it. */
  arguments: string;
}
export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: string[] /* local file paths */ }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CompleteRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** Overrides the client's model for this call. On any failure it falls back to the client's model once. */
  model?: string;
}
export interface CompleteResult {
  text: string;
  toolCalls: ToolCall[];
}
export interface Model {
  complete(request: CompleteRequest): Promise<CompleteResult>;
}

/**
 * grok-4.3: in live tests it called tools correctly and answered in 1-3 s per call. It runs the engine.
 * grok-4.20-non-reasoning answered persona-style calls in about 0.5 s (Oct 2026), so it voices the persona;
 * it has failed with 429 "model at capacity" before, so persona calls fall back to the main model.
 */
export const DEFAULT_MODEL = "grok-4.3";
export const DEFAULT_PERSONA_MODEL = "grok-4.20-non-reasoning";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const run = promisify(execFile);

export function createModel(options: { apiKey: string; model?: string; baseUrl?: string; timeoutMs?: number }): Model {
  const url = `${(options.baseUrl ?? "https://api.x.ai/v1").replace(/\/$/, "")}/chat/completions`;
  const model = options.model || DEFAULT_MODEL;

  async function post(body: unknown, retries = 1): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs ?? 90_000),
        });
      } catch (err) {
        if (attempt >= retries) throw new Error(`xAI request failed: ${(err as Error).message}`);
      }
      if (res && (res.ok || attempt >= retries || !(res.status === 429 || res.status >= 500))) return res;
      const retryAfter = Number(res?.headers.get("retry-after"));
      // Read the (small) error body to the end so its socket is released for reuse before the retry.
      await res?.arrayBuffer().catch(() => undefined);
      await new Promise((r) => setTimeout(r, Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1500));
    }
  }

  return {
    async complete({ system, messages, tools, model: override }) {
      const wire = [{ role: "system", content: system }, ...(await Promise.all(messages.map(toWire)))];
      const body = (name: string) => ({
        model: name,
        messages: wire,
        ...(tools.length ? { tools: tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
      });
      let res: Response | undefined;
      if (override && override !== model) {
        // No retry on the override: when the fast model is busy (429) or refuses the request, use the main one now.
        res = await post(body(override), 0).catch(() => undefined);
        if (res && !res.ok) {
          await res.arrayBuffer().catch(() => undefined);
          res = undefined;
        }
      }
      res ??= await post(body(model));
      const raw = await res.text();
      if (!res.ok) throw new Error(`xAI ${res.status}: ${raw.slice(0, 1000)}`);
      const data = JSON.parse(raw) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      };
      const message = data.choices?.[0]?.message;
      if (!message) throw new Error(`xAI returned no message: ${raw.slice(0, 1000)}`);
      return {
        text: message.content ?? "",
        toolCalls: (message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments || "{}" })),
      };
    },
  };
}

async function toWire(m: ChatMessage): Promise<Record<string, unknown>> {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    case "assistant":
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      };
    case "user": {
      if (!m.images?.length) return { role: "user", content: m.content };
      const parts: Record<string, unknown>[] = [{ type: "text", text: m.content || "(image)" }];
      for (const path of m.images) parts.push({ type: "image_url", image_url: { url: await imageDataUrl(path) } });
      return { role: "user", content: parts };
    }
  }
}

/** Reads an image as a data URL. HEIC/HEIF and other formats become JPEG via sips; images over 4 MB are downscaled. */
export async function imageDataUrl(path: string): Promise<string> {
  const ext = extname(path).toLowerCase();
  const native = ext === ".jpg" || ext === ".jpeg" || ext === ".png";
  const size = (await stat(path)).size;
  if (native && size <= MAX_IMAGE_BYTES) {
    return `data:image/${ext === ".png" ? "png" : "jpeg"};base64,${(await readFile(path)).toString("base64")}`;
  }
  const dir = await mkdtemp(join(tmpdir(), "agentsign-img-"));
  try {
    const out = join(dir, "image.jpg");
    await run("sips", ["-s", "format", "jpeg", path, "--out", out]);
    if ((await stat(out)).size > MAX_IMAGE_BYTES) await run("sips", ["-Z", "1600", out]);
    return `data:image/jpeg;base64,${(await readFile(out)).toString("base64")}`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
