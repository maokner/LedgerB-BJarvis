/**
 * The account page at / (and the static index.html Vercel serves): a shell the browser script fills in.
 * Signed out it shows "Sign in with your Ledger"; signed in, the command center for the account: connections,
 * the Ledger policy, friends, recent activity, what is coming, and deleting the account. Script: /dashboard.js
 * (src/web/dashboard-client.ts), data: /api/* (src/web/account.ts, contract in src/web/account-api.ts).
 */
import { BRAND, head } from "./theme.js";

const CSS = `.shell{max-width:1040px;margin:0 auto;padding:0 24px 72px}
.nav{display:flex;align-items:center;justify-content:space-between;height:64px}
.nav .who{display:flex;align-items:center;gap:14px;font-size:13.5px;color:var(--ink-2)}
main{min-height:60vh}
.loading{padding:120px 0;text-align:center;color:var(--ink-3);font-size:13.5px}
.err,.note{margin-top:14px;font-size:13.5px;line-height:1.5}.err{color:var(--bad)}.note{color:var(--ink-2)}.err:empty,.note:empty{display:none}
.log{margin-top:10px;font:11.5px/1.5 var(--mono);color:var(--ink-3);overflow-wrap:anywhere}.log:empty{display:none}
.fine{margin-top:18px;font-size:13px;line-height:1.5;color:var(--ink-3)}
/* sign in */
.login{max-width:420px;margin:9vh auto 0;padding:32px 28px 28px}
.login h1{margin-top:8px;font-size:26px;line-height:1.2;font-weight:600;letter-spacing:-.02em}
.login .lead{margin-top:10px;font-size:14.5px;line-height:1.55;color:var(--ink-2)}
.how{list-style:none;margin:22px 0 24px;border-top:1px solid var(--line)}
.how li{display:flex;gap:14px;padding:11px 0;border-bottom:1px solid var(--line);font-size:14px;color:var(--ink)}
.how li i{font-family:var(--mono);font-size:11px;color:var(--ink-3);padding-top:3px;width:14px;flex:none}
.login .fine{text-align:center}
.needs{margin-top:16px;padding:12px 14px;border-radius:10px;background:var(--paper);border:1px solid var(--line);font-size:13.5px;line-height:1.5;color:var(--ink-2)}
/* signed in */
.hero{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;padding:36px 0 28px;border-bottom:1px solid var(--line)}
.hero h1{margin-top:6px;font-size:36px;line-height:1.05;font-weight:600;letter-spacing:-.03em}
.hero .meta{margin-top:12px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;font-size:13.5px;color:var(--ink-2)}
.hero .meta .mono{font-size:12.5px;color:var(--ink)}
.iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;color:var(--ink-3)}.iconbtn:hover{background:var(--card);color:var(--ink)}.iconbtn svg{width:15px;height:15px}
.tile{min-width:240px;padding:16px 18px}
.tile .eyebrow{display:block}
.tile b{display:block;margin-top:8px;font-size:17px;font-weight:600;letter-spacing:-.01em;line-height:1.3}
.tile .sub{margin-top:4px;font-size:13px;color:var(--ink-2)}
.banner{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:20px;padding:14px 18px;border-radius:12px;background:var(--ink);color:#fff}
.banner b{font-weight:600}.banner span{display:block;font-size:13px;color:rgba(255,255,255,.7);margin-top:2px}
.banner .btn{background:#fff;color:var(--ink);height:36px;padding:0 14px;font-size:13.5px}.banner .btn:hover{background:#f2f2f0}
section{margin-top:40px}
section>header{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin-bottom:14px}
h2{font-size:17px;font-weight:600;letter-spacing:-.01em}
section>header p{font-size:13.5px;color:var(--ink-2)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:0}
.two>section{margin-top:40px}
.list{padding:0 20px}
.row{display:flex;align-items:center;gap:16px;padding:16px 0;border-top:1px solid var(--line)}
.row:first-child{border-top:0}
.row .ic{width:38px;height:38px;border-radius:10px;border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--ink-2);flex:none}.row .ic svg{width:19px;height:19px}
.row.off .ic{color:var(--ink-3);border-style:dashed}
.row .body{flex:1;min-width:0}
.row .name{display:flex;align-items:center;gap:10px;font-weight:500;font-size:14.5px}
.row .sum{margin-top:3px;font-size:13.5px;line-height:1.5;color:var(--ink-2)}
.row .det{margin-top:4px;font-size:13px;color:var(--ink)}.row .det.mono{font-size:12.5px}
.row .act{display:flex;align-items:center;gap:8px;flex:none}
.row .act .link{font-size:13px}
.form{display:flex;gap:8px;margin-top:10px}
.form input{flex:1;height:36px;padding:0 12px;border:1px solid var(--line-2);border-radius:9px;font:inherit;font-size:14px;background:var(--card);color:var(--ink)}
.form input:focus{outline:0;border-color:var(--ink)}
.rule{font-size:13.5px;line-height:1.5;color:var(--ink-2);padding:14px 0 0}
.switchrow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;border-top:1px solid var(--line)}
.switchrow:first-child{border-top:0}
.switchrow b{font-weight:500;font-size:14.5px;display:block}.switchrow span{display:block;margin-top:2px;font-size:13px;color:var(--ink-2)}
.switch{position:relative;width:40px;height:24px;border-radius:12px;background:var(--line-2);transition:background .15s;flex:none}
.switch:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:9px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}
.switch.on{background:var(--ink)}.switch.on:after{transform:translateX(16px)}
.switch:disabled{opacity:.5}
.seg{display:inline-flex;flex:none;border:1px solid var(--line-2);border-radius:9px;overflow:hidden}
.seg button{height:30px;padding:0 12px;font-size:13px;color:var(--ink-2);border-left:1px solid var(--line-2)}.seg button:first-child{border-left:0}
.seg button.on{background:var(--ink);color:#fff}
.always{display:flex;align-items:center;gap:10px;padding:14px 0 0;font-size:13px;color:var(--ink-3)}.always svg{width:16px;height:16px;flex:none}
.empty{padding:22px 0;font-size:13.5px;color:var(--ink-3)}
.friend{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 0;border-top:1px solid var(--line);font-size:14.5px;font-weight:500}
.friend:first-child{border-top:0}
.activity .row{align-items:flex-start;padding:14px 0}
.activity .when{font-size:12.5px;color:var(--ink-3);white-space:nowrap;padding-top:2px}
.activity .name{font-size:14px}
.soon{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.soon .card{display:flex;flex-direction:column;align-items:flex-start;padding:18px 18px 16px}
.soon .card b{display:block;font-weight:500;font-size:14.5px}
.soon .card p{margin-top:6px;font-size:13.5px;line-height:1.5;color:var(--ink-2)}
.soon .card .pill{margin-bottom:12px}
.danger{padding:20px}
.danger p{font-size:13.5px;line-height:1.55;color:var(--ink-2);max-width:56em}
.danger .act{display:flex;align-items:center;gap:10px;margin-top:16px}
footer{margin-top:64px;padding-top:20px;border-top:1px solid var(--line);display:flex;flex-wrap:wrap;justify-content:space-between;gap:10px;font-size:12.5px;color:var(--ink-3)}
footer a{color:var(--ink-2);text-decoration:none}footer a:hover{text-decoration:underline}
@media (max-width:820px){.two{grid-template-columns:1fr}.soon{grid-template-columns:1fr 1fr}.hero{flex-direction:column;align-items:stretch}.tile{min-width:0}}
@media (max-width:560px){.shell{padding:0 16px 56px}section>header{flex-direction:column;align-items:flex-start;gap:2px}.switchrow{flex-wrap:wrap}.soon{grid-template-columns:1fr}.row{flex-wrap:wrap}.row .act{width:100%;justify-content:flex-end;padding-left:54px}.hero h1{font-size:30px}.login{margin-top:4vh;padding:24px 20px}}`;

/** The shell. Everything inside <main> is drawn by the script. */
export function dashboardPage(): string {
  return `<!doctype html><html lang="en"><head>${head("Your account - AgentSign", CSS, `
<meta property="og:title" content="AgentSign - your account"><meta property="og:site_name" content="AgentSign">`)}</head><body>
<div class="shell">
<header class="nav">${BRAND}<div class="who" id="who"></div></header>
<main id="app"><p class="loading">Loading your account</p></main>
<footer><span>AgentSign. Every payment, and anything your policy sends there, is clear-signed on your Ledger.</span><span><a href="https://www.ledger.com/" rel="noopener noreferrer" target="_blank">Ledger</a> · <a href="https://base.org/" rel="noopener noreferrer" target="_blank">Base</a></span></footer>
</div>
<script src="/dashboard.js"></script></body></html>`;
}
