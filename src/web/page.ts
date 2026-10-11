/** The approval page at /sign/<token>: what the Ledger will show, one button, and a timeline. Script: /ledger.js. */
import { ACTION_TITLES, type Action } from "../types.js";

export interface PageView {
  action: Action;
  tag: string;
  /** The action's status in the actions table (pending, approved, executed, rejected, expired, failed). */
  status: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const STEPS = ["Request", "Ledger", "Verified", "Done"];
const at: Record<string, number> = { pending: 1, approved: 2, executed: 4, rejected: 1, expired: 1, failed: 2 };
const eyebrow: Record<string, string> = {
  pending: "Approve on your Ledger", approved: "Verified. Finishing up", executed: "Done",
  rejected: "Rejected", expired: "Expired", failed: "Did not go through",
};
const LEDGER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="10" rx="2.5"/><path d="M7 10.5h6v3H7zM17 10.5v3"/></svg>`;
const CHECK = `<svg viewBox="0 0 56 56" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="28" cy="28" r="26"/><path d="M17 29l7 7 15-16"/></svg>`;

const CSS = `:root{--bg:#F5F5F5;--panel:#fff;--line:#E3E3E3;--text:#0A0A0A;--muted:#6E6E6E;--accent:#FF5A1F;--ok:#0E8F63;--bad:#C8102E}
*{box-sizing:border-box;margin:0}[hidden]{display:none!important}
body{font-family:Inter,-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--text);min-height:100dvh;-webkit-font-smoothing:antialiased;overflow-x:hidden}
body:before{content:"";position:fixed;inset:0;background-image:linear-gradient(rgba(0,0,0,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(0,0,0,.045) 1px,transparent 1px);background-size:44px 44px;-webkit-mask-image:radial-gradient(ellipse 80% 60% at 50% 35%,#000 30%,transparent 100%);mask-image:radial-gradient(ellipse 80% 60% at 50% 35%,#000 30%,transparent 100%);pointer-events:none}
body:after{content:"";position:fixed;inset:0;background:radial-gradient(ellipse 70% 45% at 50% 40%,rgba(255,90,31,.06),transparent 70%);pointer-events:none}
main{position:relative;z-index:1;max-width:460px;margin:0 auto;padding:calc(env(safe-area-inset-top) + 28px) 16px 40px}
.rise{opacity:0;animation:rise .7s cubic-bezier(.16,1,.3,1) forwards}
@keyframes rise{from{opacity:0;transform:translateY(14px);filter:blur(6px)}to{opacity:1;transform:none;filter:none}}
.brand{display:flex;align-items:center;gap:10px;font-size:17px;font-weight:500;letter-spacing:-.4px}
.glyph{width:30px;height:20px;border-radius:5px;background:var(--text);position:relative;box-shadow:0 4px 12px rgba(0,0,0,.2)}
.glyph:before{content:"";position:absolute;left:5px;top:6px;width:12px;height:8px;border-radius:1.5px;background:rgba(255,255,255,.9)}
.glyph:after{content:"";position:absolute;right:5px;top:6px;width:2px;height:8px;border-radius:1px;background:rgba(255,255,255,.5)}
.eyebrow{margin-top:34px;font-size:15px;font-weight:500;color:var(--accent)}.eyebrow.executed{color:var(--ok)}.eyebrow.rejected,.eyebrow.expired,.eyebrow.failed{color:var(--bad)}
h1{margin-top:8px;font-size:30px;line-height:1.08;font-weight:600;letter-spacing:-1.1px}
.detail{margin-top:8px;color:var(--muted);font-size:15px}
.card{margin-top:24px;background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:22px;box-shadow:0 24px 60px rgba(0,0,0,.06)}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:18px}
.chip{font-size:13px;font-weight:500;padding:5px 11px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.price{font-size:44px;font-weight:600;letter-spacing:-2px;line-height:1}.price small{display:block;font-size:14px;font-weight:500;letter-spacing:0;color:var(--muted);margin-top:8px}
.rows{border-top:1px solid var(--line)}.card>.rows:first-child{border-top:0}
.rows div{display:flex;justify-content:space-between;gap:16px;padding:13px 0;border-bottom:1px solid var(--line);font-size:15px}
.rows div:last-child{border-bottom:0;padding-bottom:0}
.rows dt{color:var(--muted);flex:none}.rows dd{font-weight:500;text-align:right;overflow-wrap:anywhere}
.rows div.addr{flex-direction:column;gap:6px}.rows div.addr dd{text-align:left;font:500 13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
ol{list-style:none;padding:0;margin-top:26px;display:grid;grid-template-columns:repeat(4,1fr);position:relative}
ol:before,ol:after{content:"";position:absolute;left:12.5%;top:6px;height:2px}
ol:before{right:12.5%;background:var(--line)}ol:after{width:calc(75% * var(--p));background:var(--text);transition:width .5s}
li{position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;font-size:12px;color:var(--muted);font-weight:500}
li i{width:14px;height:14px;border-radius:7px;background:#D4D4D4;position:relative;z-index:1;box-shadow:0 0 0 4px var(--bg)}
li.done i{background:var(--text)}li.done,li.now,li.fail{color:var(--text)}li.fail i{background:var(--bad)}
li.now i{background:var(--accent);animation:pulse 1.6s ease-out infinite}
li:last-child.done i{background:var(--ok)}
@keyframes pulse{0%{box-shadow:0 0 0 4px var(--bg),0 0 0 4px rgba(255,90,31,.35)}100%{box-shadow:0 0 0 4px var(--bg),0 0 0 14px rgba(255,90,31,0)}}
button,.ghost{margin-top:26px;width:100%;height:58px;border:0;border-radius:16px;display:flex;align-items:center;justify-content:center;gap:10px;font:600 17px Inter,-apple-system,sans-serif;letter-spacing:-.2px;text-decoration:none;cursor:pointer}
button{background:var(--text);color:#fff;box-shadow:0 14px 34px rgba(0,0,0,.18);transition:transform .15s,opacity .15s}
button:active{transform:scale(.98)}button svg{width:24px;height:24px}button[disabled]{opacity:.6;cursor:default}
.ghost{display:none;background:var(--panel);border:1px solid var(--line);color:var(--text);font-size:15px;font-weight:500}
.hint{margin-top:14px;padding:12px 14px;border-radius:12px;background:#FFF3EC;color:#7A2E0B;font-size:14px;line-height:1.45;text-align:center}.hint:empty{display:none}
.log{margin-top:10px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9A9A9A;text-align:center;overflow-wrap:anywhere}.log:empty{display:none}
.fine{margin-top:14px;font-size:13px;line-height:1.45;color:var(--muted);text-align:center}
.ok{margin-top:26px;display:none;flex-direction:column;align-items:center;gap:10px;text-align:center}
.ok svg{width:64px;height:64px}.ok circle{stroke:var(--ok);stroke-dasharray:166;stroke-dashoffset:166;animation:draw .6s cubic-bezier(.16,1,.3,1) forwards}
.ok path{stroke:var(--ok);stroke-dasharray:48;stroke-dashoffset:48;animation:draw .4s .45s cubic-bezier(.16,1,.3,1) forwards}
@keyframes draw{to{stroke-dashoffset:0}}
.ok b{font-size:20px;font-weight:600;letter-spacing:-.4px}
.err,.note{margin-top:14px;text-align:center;font-size:14px;line-height:1.45}.err{color:var(--bad)}.note{color:var(--muted)}
.err:empty,.note:empty{display:none}`;

const isAddress = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);

export function page(v: PageView): string {
  const { action } = v;
  const title = ACTION_TITLES[action.code];
  const n = at[v.status] ?? 1;
  const steps = STEPS.map((name, i) => `<li class="${i < n ? "done" : i === n ? (v.status === "rejected" || v.status === "expired" || v.status === "failed" ? "fail" : "now") : ""}"><i></i><span>${name}</span></li>`).join("");
  const amount = action.code === "PAY" ? action.fields.find((f) => f.label === "Amount") : undefined;
  const eth = action.code === "PAY" ? action.fields.find((f) => f.label === "ETH") : undefined;
  const rows = action.fields
    .filter((f) => f !== amount && f !== eth)
    .map((f) => `<div${isAddress(f.value) ? ' class="addr"' : ""}><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></div>`)
    .join("");
  const top = amount
    ? `<div class="top"><span class="price">${esc(amount.value)}${eth ? `<small>${esc(eth.value)} ETH</small>` : ""}</span><span class="chip">Base</span></div>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} - AgentSign</title>
<meta property="og:title" content="${esc(`${title} - approve on your Ledger`)}"><meta property="og:site_name" content="AgentSign">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><main>
<div class="brand rise"><span class="glyph"></span>AgentSign</div>
<p class="eyebrow rise ${esc(v.status)}" id="eyebrow" style="animation-delay:.05s">${esc(eyebrow[v.status] ?? "")}</p>
<h1 class="rise" style="animation-delay:.1s">${esc(title)}</h1>
<p class="detail rise" style="animation-delay:.14s">For ${esc(v.tag)}</p>
<section class="card rise" style="animation-delay:.18s">${top}<dl class="rows">${rows}</dl></section>
<ol id="steps" class="rise" style="animation-delay:.24s;--p:${Math.min(n, 3) / 3}">${steps}</ol>
<div class="rise" style="animation-delay:.3s" id="act">${
    v.status === "pending"
      ? `<button id="go">${LEDGER}<span id="goLabel">Approve on Ledger</span></button>
<p class="hint" id="hint"></p>
<p class="log" id="log"></p>
<p class="fine">Your Ledger shows exactly this and signs it. Nothing happens without that signature.</p>`
      : `<button id="go" hidden></button><span id="goLabel" hidden></span><p id="hint" hidden></p><p id="log" hidden></p>`
  }</div>
<div class="ok" id="ok">${CHECK}<b id="okTitle">Done</b></div>
<a class="ghost" id="tx" target="_blank" rel="noopener noreferrer">View on Basescan</a>
<p class="err" id="err"></p>
</main><script src="/ledger.js"></script></body></html>`;
}

/** A page with just a headline and a line under it (expired links, "connected", errors). `detail` may hold escaped HTML. */
export function messagePage(o: { eyebrow: string; title: string; detail: string; tone?: "ok" | "bad" }): string {
  const tone = o.tone === "ok" ? " executed" : o.tone === "bad" ? " failed" : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer"><title>${esc(o.title)} - AgentSign</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body><main>
<div class="brand rise"><span class="glyph"></span>AgentSign</div><p class="eyebrow rise${tone}" style="animation-delay:.05s">${esc(o.eyebrow)}</p>
<h1 class="rise" style="animation-delay:.1s">${esc(o.title)}</h1><p class="detail rise" style="animation-delay:.14s">${o.detail}</p>
</main></body></html>`;
}

/** For a link that does not exist (wrong or truncated). */
export function notFoundPage(): string {
  return messagePage({ eyebrow: "Link not found", title: "This link is not valid.", detail: "Check that you opened the whole link from the text, or ask the agent again." });
}
