/**
 * The approval page at /sign/<token>: the lines the Ledger will show, one button, and a quiet progress line.
 * Script: /ledger.js (src/web/ledger-client.ts). The look comes from src/web/theme.ts.
 */
import { ACTION_TITLES, type Action, isTxCode } from "../types.js";
import { BRAND, esc, head, ICONS, TONE } from "./theme.js";

export interface PageView {
  action: Action;
  tag: string;
  /** The action's status in the actions table (pending, approved, executed, rejected, expired, failed). */
  status: string;
}

const STEPS = ["Request", "Ledger", "Verified", "Done"];
const at: Record<string, number> = { pending: 1, approved: 2, executed: 4, rejected: 1, expired: 1, failed: 2 };
const eyebrow: Record<string, string> = {
  pending: "Waiting for your Ledger", approved: "Verified, finishing up", executed: "Done",
  rejected: "Rejected", expired: "Expired", failed: "Did not go through",
};

const CSS = `main{max-width:440px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 28px) 20px 56px}
header{display:flex;align-items:center;justify-content:space-between;height:28px}
.top{margin-top:44px}
h1{margin-top:6px;font-size:28px;line-height:1.15;font-weight:600;letter-spacing:-.02em}
.for{margin-top:4px;font-size:14px;color:var(--ink-2)}
.card{margin-top:22px;padding:4px 20px}
.amount{padding:18px 0 16px;border-bottom:1px solid var(--line)}
.amount b{display:block;font-size:34px;line-height:1.1;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums}
.amount span{display:block;margin-top:6px;font-size:13px;color:var(--ink-2)}
.rows div{display:flex;justify-content:space-between;align-items:baseline;gap:18px;padding:13px 0;border-top:1px solid var(--line);font-size:14.5px}
.rows div:first-child{border-top:0}
.rows dt{color:var(--ink-2);flex:none}.rows dd{font-weight:500;text-align:right;overflow-wrap:anywhere}
.rows div.addr{flex-direction:column;align-items:stretch;gap:5px}.rows div.addr dd{text-align:left;font:12.5px/1.6 var(--mono);font-weight:400;color:var(--ink)}
.steps{list-style:none;display:grid;grid-template-columns:repeat(4,1fr);margin-top:22px;padding-top:12px;position:relative}
.steps:before,.steps:after{content:"";position:absolute;left:0;top:0;height:2px;border-radius:1px}
.steps:before{right:0;background:var(--line)}.steps:after{width:calc(100% * var(--p));background:var(--ink);transition:width .4s}
.steps li{font-family:var(--mono);font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3);text-align:center}
.steps li:first-child{text-align:left}.steps li:last-child{text-align:right}
.steps li.done,.steps li.now{color:var(--ink)}.steps li.fail{color:var(--bad)}
.steps li.now:after{content:"";display:inline-block;width:5px;height:5px;border-radius:3px;background:var(--ink);margin-left:6px;vertical-align:1px;animation:blink 1.4s ease-in-out infinite}
@keyframes blink{50%{opacity:.25}}
#act{margin-top:24px}
.hint{margin-top:14px;padding:12px 14px;border-radius:10px;background:var(--card);border:1px solid var(--line);font-size:13.5px;line-height:1.5;color:var(--ink);text-align:center}.hint:empty{display:none}
.log{margin-top:10px;font:11.5px/1.5 var(--mono);color:var(--ink-3);text-align:center;overflow-wrap:anywhere}.log:empty{display:none}
.fine{margin-top:14px;font-size:13px;line-height:1.5;color:var(--ink-3);text-align:center}
.ok{margin-top:28px;display:none;flex-direction:column;align-items:center;gap:12px;text-align:center}
.ok i{width:40px;height:40px;border-radius:20px;background:var(--ink);color:#fff;display:flex;align-items:center;justify-content:center}.ok i svg{width:20px;height:20px}
.ok b{font-size:17px;font-weight:600;letter-spacing:-.01em}
.ghost{display:none;margin:16px auto 0;font-size:14px}
.err,.note{margin-top:14px;text-align:center;font-size:13.5px;line-height:1.5}.err{color:var(--bad)}.note{color:var(--ink-2)}
.err:empty,.note:empty{display:none}
.detail{margin-top:10px;font-size:15px;line-height:1.55;color:var(--ink-2);max-width:36em}
.action{margin-top:24px}`;

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

export function page(v: PageView): string {
  const { action } = v;
  const title = ACTION_TITLES[action.code];
  const n = at[v.status] ?? 1;
  const failed = v.status === "rejected" || v.status === "expired" || v.status === "failed";
  const steps = STEPS.map((name, i) => `<li class="${i < n ? "done" : i === n ? (failed ? "fail" : "now") : ""}">${name}</li>`).join("");
  // The headline: Amount for a payment, Total for a purchase (BUY, EAT), with the on-chain amount under it.
  const amount = isTxCode(action.code) ? action.fields.find((f) => f.label === "Amount" || f.label === "Total") : undefined;
  const eth = isTxCode(action.code) ? action.fields.find((f) => f.label === "ETH" || f.label === "USDC") : undefined;
  const rows = action.fields
    .filter((f) => f !== amount && f !== eth)
    .map((f) => `<div${isAddress(f.value) ? ' class="addr"' : ""}><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`)
    .join("");
  const top = amount ? `<div class="amount"><b>${esc(amount.value)}</b>${eth ? `<span>${esc(eth.value)} ${esc(eth.label)} on Base</span>` : ""}</div>` : "";
  return `<!doctype html><html lang="en"><head>${head(`${title} - AgentSign`, CSS, `
<meta property="og:title" content="${esc(`${title} - approve on your Ledger`)}"><meta property="og:site_name" content="AgentSign">`)}</head><body><main>
<header>${BRAND}<span class="eyebrow">Approval</span></header>
<div class="top"><p class="eyebrow ${esc(TONE[v.status] ?? "")}" id="eyebrow">${esc(eyebrow[v.status] ?? "")}</p>
<h1>${esc(title)}</h1>
<p class="for">for ${esc(v.tag)}</p></div>
<section class="card">${top}<dl class="rows">${rows}</dl></section>
<ol id="steps" class="steps" style="--p:${Math.min(n, 3) / 3}">${steps}</ol>
<div id="act">${
    v.status === "pending"
      ? `<button class="btn block" id="go">${ICONS.ledger}<span id="goLabel">Approve on Ledger</span></button>
<p class="hint" id="hint"></p>
<p class="log" id="log"></p>
<p class="fine">Your Ledger shows exactly these lines and signs them. Nothing happens without that signature.</p>`
      : `<button id="go" hidden></button><span id="goLabel" hidden></span><p id="hint" hidden></p><p id="log" hidden></p>`
  }</div>
<div class="ok" id="ok"><i>${ICONS.check}</i><b id="okTitle">Done</b></div>
<a class="ghost link" id="tx" target="_blank" rel="noopener noreferrer">View on Basescan</a>
<p class="err" id="err"></p>
</main><script src="/ledger.js"></script></body></html>`;
}

/** A page with just a headline and a line under it (expired links, "connected", errors). `detail` may hold escaped HTML. */
export function messagePage(o: { eyebrow: string; title: string; detail: string; tone?: "ok" | "bad"; action?: { label: string; href: string } }): string {
  const t = o.tone === "ok" ? " good" : o.tone === "bad" ? " bad" : "";
  const action = o.action ? `<p class="action"><a class="btn" href="${esc(o.action.href)}">${esc(o.action.label)}</a></p>` : "";
  return `<!doctype html><html lang="en"><head>${head(`${o.title} - AgentSign`, CSS)}</head><body><main>
<header>${BRAND}</header>
<div class="top"><p class="eyebrow${t}">${esc(o.eyebrow)}</p>
<h1>${esc(o.title)}</h1><p class="detail">${o.detail}</p>${action}</div>
</main></body></html>`;
}

/** For a link that does not exist (wrong or truncated). */
export function notFoundPage(): string {
  return messagePage({ eyebrow: "Link not found", title: "This link is not valid.", detail: "Check that you opened the whole link from the text, or ask the agent again." });
}
