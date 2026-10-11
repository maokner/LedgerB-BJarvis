/**
 * Ethereum mode without a USB cable to the server: every approval gets a link (PUBLIC_URL/sign/<token>).
 * The page behind it (src/web/) talks to the Ledger over WebHID on whatever computer it is plugged into and
 * posts the answer back here; ethProof() checks it exactly like a USB answer before sign() resolves.
 * Sign-up from an unknown Ledger uses pubkey ANY_DEVICE (""): the page signs the ACC message and the signer is recovered.
 *
 * combineDeviceManagers([usb, remote]) asks both at once; the first real answer wins and the other is cancelled.
 * When USB gives up ("no_device" after its timeout) the combined sign() keeps waiting for the link until it expires.
 */
import { randomBytes } from "node:crypto";
import type { Db, SigningJob, SigningJobStatus } from "../db.js";
import type { Action, DeviceManager, SignOptions, SignResult } from "../types.js";
import type { EthAnswer } from "./eth-tx.js";
import { ethProof } from "./eth-verify.js";

/** How long a link stays valid, independent of SignOptions.timeoutMs (USB may stop looking sooner): sign-up 10 min, the rest 5. */
export const linkWindowMs = (action: Action): number => (action.code === "ACC" ? 10 : 5) * 60_000;
/** The longest window; settled jobs are dropped from memory this long after they expire. */
export const JOB_TTL_MS = 10 * 60_000;

export type SubmitResult = { ok: true; status: SigningJobStatus } | { ok: false; status: SigningJobStatus | "unknown"; error: string };

export interface RemoteDeviceManager extends DeviceManager {
  prepare(pubkey: string, action: Action): Promise<{ url: string; expiresAt: number }>;
  /** The job behind a token (live or from an earlier run), with the owner's @tag. */
  job(token: string): (SigningJob & { tag: string }) | undefined;
  /** The page loaded the job: a timeout now means "nobody answered" rather than "no device". */
  opened(token: string): void;
  /** `claimed`: the address the page read from the device, for the log only; the signature decides. */
  submit(token: string, answer: EthAnswer, claimed?: string): SubmitResult;
  reject(token: string): SubmitResult;
}

interface Live {
  token: string;
  pubkey: string;
  action: Action;
  status: SigningJobStatus;
  opened: boolean;
  expiresAt: number;
  timer?: NodeJS.Timeout;
  result?: SignResult;
  waiter?: (result: SignResult) => void;
  /** With ANY_DEVICE: which signers may answer (from SignOptions.accept). */
  accept?: (pubkey: string) => boolean;
  /** From SignOptions.claim: called when the page loads the job, so the USB side stops polling for it. */
  claim?: () => void;
}

export const TAKEN_BY_USB = "The Ledger plugged into the AgentSign Mac took this request over USB. Approve or reject it there.";

const REFUSED: Record<SigningJobStatus, string> = {
  pending: "",
  signed: "This request was already approved.",
  rejected: "This request was rejected.",
  expired: "This request expired on the server. Ask Jarvis again and open the new link.",
  superseded: TAKEN_BY_USB,
};

export function createRemoteDeviceManager(options: { db: Db; publicUrl: string; log?: (line: string) => void; windowMs?: (action: Action) => number }): RemoteDeviceManager {
  const { db } = options;
  const base = options.publicUrl.replace(/\/+$/, "");
  const log = options.log ?? (() => {});
  const windowMs = options.windowMs ?? linkWindowMs;
  const jobs = new Map<string, Live>();
  const stale = db.expireSigningJobs();
  if (stale) log(`expired ${stale} signing link(s) left pending by a previous run`);

  const short = (job: Live) => `${job.action.id.slice(0, 8)} (link ${job.token.slice(0, 6)}...)`;
  const tagOf = (pubkey: string, action: Action) =>
    (action.code === "ACC" ? action.fields.find((f) => f.label === "Tag")?.value : db.accountByPubkey(pubkey)?.tag) ?? "your account";

  /** Ends a pending job once; whoever waits in sign() gets `result`. */
  function settle(job: Live, status: SigningJobStatus, result: SignResult): boolean {
    if (job.status !== "pending") return false;
    job.status = status;
    job.result = result;
    clearTimeout(job.timer);
    db.setSigningJobStatus(job.token, status);
    log(`signing link for ${short(job)} -> ${status}`);
    job.waiter?.(result);
    return true;
  }

  function arm(job: Live): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(() => settle(job, "expired", { status: job.opened ? "timeout" : "no_device", expiredLink: true }), Math.max(0, job.expiresAt - Date.now()));
    job.timer.unref?.();
  }

  function register(pubkey: string, action: Action): Live {
    const address = pubkey.toLowerCase();
    const existing = [...jobs.values()].find((j) => j.action.id === action.id && j.pubkey === address);
    if (existing) return existing;
    for (const [token, j] of jobs) if (j.status !== "pending" && j.expiresAt < Date.now() - JOB_TTL_MS) jobs.delete(token);
    const job: Live = { token: randomBytes(32).toString("hex"), pubkey: address, action, status: "pending", opened: false, expiresAt: Date.now() + windowMs(action) };
    db.insertSigningJob(job.token, address, action, new Date(job.expiresAt));
    jobs.set(job.token, job);
    arm(job);
    return job;
  }

  function refuse(token: string): SubmitResult | undefined {
    const job = jobs.get(token);
    if (job?.status === "pending" && Date.now() >= job.expiresAt) settle(job, "expired", { status: job.opened ? "timeout" : "no_device", expiredLink: true });
    const status = job?.status ?? db.signingJob(token)?.status;
    if (!status) return { ok: false, status: "unknown", error: "This link is not valid." };
    return status === "pending" ? undefined : { ok: false, status, error: REFUSED[status] };
  }

  return {
    list: async () => [],
    async prepare(pubkey, action) {
      const job = register(pubkey, action);
      return { url: `${base}/sign/${job.token}`, expiresAt: job.expiresAt };
    },
    sign(pubkey: string, action: Action, signOptions: SignOptions = {}): Promise<SignResult> {
      const job = register(pubkey, action);
      if (job.result) return Promise.resolve(job.result);
      // The link keeps its own window; signOptions.timeoutMs only bounds the USB side of the race.
      job.accept = signOptions.accept;
      job.claim = signOptions.claim;
      // The page may have loaded the job between the text going out and sign() being called.
      if (job.opened) job.claim?.();
      return new Promise((resolve) => {
        job.waiter = resolve;
        const { signal } = signOptions;
        if (signal?.aborted) settle(job, "superseded", { status: "no_device" });
        else signal?.addEventListener("abort", () => settle(job, "superseded", { status: "no_device" }), { once: true });
      });
    },
    job(token) {
      const live = jobs.get(token);
      const row = db.signingJob(token);
      if (!row) return undefined;
      return { ...row, status: live?.status ?? row.status, tag: tagOf(row.pubkey, row.action) };
    },
    opened(token) {
      const job = jobs.get(token);
      if (!job) return;
      if (!job.opened) log(`signing link for ${short(job)} opened`);
      job.opened = true;
      // The person is answering through the page: the USB side must not touch the Ledger any more.
      if (job.status === "pending") job.claim?.();
    },
    submit(token, answer, claimed) {
      const refused = refuse(token);
      if (refused) return refused;
      const job = jobs.get(token)!;
      // The job stays open after a refusal: the right Ledger can still answer.
      const proof = ethProof(job.pubkey, job.action, answer, "page");
      if ("error" in proof) {
        log(`signing link for ${short(job)}: refused an answer (${proof.error})`);
        return { ok: false, status: "pending", error: `That did not come from the Ledger bound to ${tagOf(job.pubkey, job.action)}, so nothing happened.` };
      }
      if (!job.pubkey && (db.accountByPubkey(proof.address) || job.accept?.(proof.address) === false)) {
        log(`signing link for ${short(job)}: refused ${proof.address}, already bound`);
        return { ok: false, status: "pending", error: "This Ledger already has an account. Use a Ledger without one." };
      }
      if (claimed && claimed.toLowerCase() !== proof.address) log(`signing link for ${short(job)}: the page read ${claimed.toLowerCase()} but ${proof.address} signed`);
      settle(job, "signed", { status: "approved", signature: proof.signature, pubkey: proof.address });
      return { ok: true, status: "signed" };
    },
    reject(token) {
      const refused = refuse(token);
      if (refused) return refused;
      settle(jobs.get(token)!, "rejected", { status: "rejected" });
      return { ok: true, status: "rejected" };
    },
    async close() {
      for (const job of jobs.values()) settle(job, "expired", { status: "no_device" });
    },
  };
}

/**
 * Asks every manager at once. list() is everyone's devices; prepare() is the first link offered.
 * sign() takes the first answer that is not "no_device" and aborts the others (a remote job becomes "superseded").
 * The first manager to claim the request (the page was opened, or a USB device shows it) also stops the others:
 * the two must never work the same Ledger at once.
 */
export function combineDeviceManagers(managers: DeviceManager[]): DeviceManager {
  return {
    list: async () => (await Promise.all(managers.map((m) => m.list()))).flat(),
    async prepare(pubkey, action) {
      for (const m of managers) {
        const prepared = await m.prepare?.(pubkey, action);
        if (prepared?.url) return prepared;
      }
      return {};
    },
    sign(pubkey, action, options = {}) {
      const controllers = managers.map(() => new AbortController());
      options.signal?.addEventListener("abort", () => controllers.forEach((c) => c.abort()), { once: true });
      return new Promise((resolve) => {
        let left = managers.length;
        let done = false;
        let claimed = false;
        managers.forEach((m, i) => {
          const claim = () => {
            if (done || claimed) return;
            claimed = true;
            controllers.forEach((c, j) => j !== i && c.abort());
            options.claim?.();
          };
          m.sign(pubkey, action, { ...options, signal: controllers[i]!.signal, claim })
            .catch((err: unknown): SignResult => ({ status: "error", message: err instanceof Error ? err.message : String(err) }))
            .then((result) => {
              left -= 1;
              if (done || (result.status === "no_device" && left > 0)) return;
              done = true;
              controllers.forEach((c, j) => j !== i && c.abort());
              resolve(result);
            });
        });
      });
    },
    async close() {
      await Promise.all(managers.map((m) => m.close()));
    },
  };
}
