/**
 * The account page at / (and the static index.html Vercel serves): an app shell the browser script fills in.
 * A sidebar with the sections, a top bar with the page title and "Text Jarvis", the main column, and a right rail
 * with the account at a glance. Signed out, the main column holds "Sign in with your Ledger". Script: /dashboard.js
 * (src/web/dashboard-client.ts), data: /api/* (src/web/account.ts, contract in src/web/account-api.ts).
 */
import { BRAND, head, ICONS } from "./theme.js";

const CSS = `:root{--blue:#1A5CFF;--blue-soft:#E9F0FF;--blue-ink:#1747C8;--green-soft:#E6F4EC;--red-soft:#FDECEC;--side-w:272px;--rail-w:336px}
body{background:var(--card)}
.app{display:grid;grid-template-columns:var(--side-w) 1fr;min-height:100dvh}
/* sidebar */
.side{background:var(--paper);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:18px 14px 16px;position:sticky;top:0;height:100dvh;overflow:auto}
.side-top{display:flex;align-items:center;justify-content:space-between;padding:4px 8px 16px}
.side-top .brand{font-size:18px;gap:12px}.side-top .brand img{height:42px}
.search{display:flex;align-items:center;gap:10px;height:42px;padding:0 14px;border-radius:12px;background:var(--line);color:var(--ink-3);margin-bottom:14px}
.search svg{width:17px;height:17px;flex:none}
.search input{flex:1;border:0;background:none;font:inherit;font-size:15px;color:var(--ink);outline:0;min-width:0}
.search input::placeholder{color:var(--ink-3)}
nav .navhead{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);padding:16px 10px 8px}
.navitem{display:flex;align-items:center;gap:12px;height:46px;padding:0 12px;border-radius:12px;font-size:15.5px;color:var(--ink);text-decoration:none;border:1px solid transparent}
.navitem svg{width:19px;height:19px;color:var(--ink-2);flex:none}
.navitem:hover{background:rgba(0,0,0,.035)}
.navitem.on{background:var(--card);border-color:var(--line);font-weight:500}
.navitem .count{margin-left:auto;font-size:12px;color:var(--ink-3)}
.side-bottom{margin-top:auto;padding-top:18px;display:flex;flex-direction:column;gap:10px}
.mini{display:flex;align-items:center;gap:12px;padding:10px 10px;border-radius:12px;text-decoration:none;color:inherit}
.mini .ic{width:38px;height:38px;border-radius:10px;background:var(--card);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--ink-2);flex:none}.mini .ic svg{width:18px;height:18px}
.mini b{display:block;font-weight:500;font-size:14.5px}.mini span{display:block;font-size:12.5px;color:var(--ink-3)}
.mini.card{background:var(--line);border:0}
.mini.wait .ic{background:var(--ink);color:#fff;border-color:var(--ink)}
.user{display:flex;align-items:center;gap:12px;padding:8px 10px}
.avatar{width:38px;height:38px;border-radius:19px;background:#0E7A62;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:15px;flex:none}
.user b{display:block;font-weight:500;font-size:14.5px}.user div span{display:block;font-size:12.5px;color:var(--ink-3)}
/* top bar and columns */
.wrap{display:flex;flex-direction:column;min-width:0}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;height:84px;padding:0 28px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card);z-index:2}
.top h1{font-size:18px;font-weight:500;letter-spacing:-.01em;display:flex;align-items:center;gap:14px}
.top h1 svg{width:20px;height:20px;color:var(--ink-3)}
.top .acts{display:flex;align-items:center;gap:10px}
.btn.text{background:#1B1B1A;height:48px;padding:0 20px;border-radius:14px;font-size:15.5px;box-shadow:0 1px 2px rgba(0,0,0,.2)}.btn.text:hover{background:#000}
.btn.text .ap{width:22px;height:22px;border-radius:6px;background:#34C759;color:#fff;display:flex;align-items:center;justify-content:center}.btn.text .ap svg{width:14px;height:14px}
.btn.soft{background:var(--blue-soft);color:var(--blue-ink);height:48px;padding:0 18px;border-radius:14px;font-size:15px}.btn.soft:hover{background:#DCE7FF}
.btn.quiet.tall{height:48px;padding:0 18px;border-radius:14px;font-size:15px}
.cols{display:grid;grid-template-columns:minmax(0,1fr) var(--rail-w);min-height:calc(100dvh - 84px)}
main{padding:34px 40px 64px;max-width:980px;min-width:0}
.rail{border-left:1px solid var(--line);padding:30px 28px 40px}
/* main column */
.hey{font-size:32px;font-weight:500;letter-spacing:-.02em;margin-bottom:26px}
h2.sec{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:500;letter-spacing:-.015em;margin:36px 0 14px}
h2.sec svg{width:20px;height:20px;color:var(--ink-2)}
h2.sec .more{margin-left:auto;font-size:14px;font-weight:400;color:var(--ink-2);text-decoration:none;display:flex;align-items:center;gap:4px}h2.sec .more svg{width:15px;height:15px}
.card{border-radius:16px}
.setup{padding:26px 28px 22px}
.setup h3{font-size:22px;font-weight:500;letter-spacing:-.015em}
.setup .lead{margin-top:6px;font-size:15px;color:var(--ink-2)}
.prog{display:flex;align-items:center;gap:18px;margin:18px 0 10px}
.bar{flex:1;height:8px;border-radius:4px;background:var(--line);overflow:hidden}.bar i{display:block;height:100%;background:var(--blue);border-radius:4px;transition:width .4s}
.prog span{font-size:14.5px;color:var(--ink-2);white-space:nowrap}
.step{display:flex;align-items:center;gap:16px;padding:16px 0;border-top:1px solid var(--line)}
.step:first-of-type{border-top:0}
.step .ic{width:46px;height:46px;border-radius:23px;background:var(--paper);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--ink-2);flex:none}.step .ic svg{width:20px;height:20px}
.step .body{flex:1;min-width:0}
.step b{display:block;font-weight:500;font-size:16px}.step.done b{text-decoration:line-through;color:var(--ink-2)}
.step span{display:block;margin-top:2px;font-size:14px;color:var(--ink-2)}
.step .act{flex:none;display:flex;gap:8px;align-items:center}
.ok-pill{display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 14px;border-radius:17px;background:var(--green-soft);color:#157A45;font-size:14.5px;font-weight:500}.ok-pill svg{width:15px;height:15px}
.btn.dark{height:44px;padding:0 20px;border-radius:14px;font-size:15px;background:#1B1B1A}
.rows2 .r{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 24px;border-top:1px solid var(--line);font-size:15.5px}
.rows2 .r:first-child{border-top:0}
.rows2 .r .k{display:flex;align-items:center;gap:12px;color:var(--ink-2)}.rows2 .r .k svg{width:18px;height:18px}
.rows2 .r .v{font-weight:500;text-align:right;overflow-wrap:anywhere}.rows2 .r .v.mono{font-size:13.5px;font-weight:400}
.rows2 .r .v .pill{margin-left:8px}
.who{display:flex;align-items:center;gap:18px;padding:24px;border-bottom:1px solid var(--line)}
.who .avatar{width:64px;height:64px;border-radius:32px;font-size:26px}
.who b{display:block;font-size:24px;font-weight:500;letter-spacing:-.015em}.who div span{display:block;margin-top:2px;font-size:15px;color:var(--ink-2)}
.who .act{margin-left:auto}
.svc{display:flex;align-items:center;gap:16px;padding:18px 22px;border-top:1px solid var(--line)}
.svc:first-child{border-top:0}
.svc .logo{width:46px;height:46px;border-radius:12px;border:1px solid var(--line);background:var(--paper);display:flex;align-items:center;justify-content:center;color:var(--ink-2);flex:none}.svc .logo svg{width:21px;height:21px}
.svc.off .logo{color:var(--ink-3);border-style:dashed}
.svc .body{flex:1;min-width:0}
.svc b{display:block;font-weight:500;font-size:16px}
.svc .sum{display:block;margin-top:2px;font-size:14px;color:var(--ink-2);line-height:1.45}
.svc .det{display:block;margin-top:4px;font-size:13.5px;color:var(--ink)}.svc .det.mono{font-size:12.5px}
.svc .act{display:flex;align-items:center;gap:8px;flex:none}
.svc .act .link{font-size:13.5px}
.form{display:flex;gap:8px;margin-top:10px}
.form input{flex:1;height:40px;padding:0 12px;border:1px solid var(--line-2);border-radius:10px;font:inherit;font-size:14.5px;background:var(--card);color:var(--ink)}
.form input:focus{outline:0;border-color:var(--ink)}
.err,.note{margin-top:10px;font-size:14px;line-height:1.5}.err{color:var(--bad)}.note{color:var(--ink-2)}.err:empty,.note:empty{display:none}
.log{margin-top:10px;font:11.5px/1.5 var(--mono);color:var(--ink-3);overflow-wrap:anywhere}.log:empty{display:none}
.empty{padding:26px 24px;font-size:14.5px;color:var(--ink-3)}
/* policy */
.switchrow{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:18px 24px;border-top:1px solid var(--line)}
.switchrow:first-child{border-top:0}
.switchrow b{font-weight:500;font-size:15.5px;display:block}.switchrow span{display:block;margin-top:2px;font-size:14px;color:var(--ink-2);max-width:48em}
.switch{position:relative;width:44px;height:26px;border-radius:13px;background:var(--line-2);transition:background .15s;flex:none}
.switch:after{content:"";position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:10px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .15s}
.switch.on{background:var(--ink)}.switch.on:after{transform:translateX(18px)}
.switch:disabled{opacity:.5}
.seg{display:inline-flex;flex:none;border:1px solid var(--line-2);border-radius:11px;overflow:hidden}
.seg button{height:36px;padding:0 14px;font-size:14px;color:var(--ink-2);border-left:1px solid var(--line-2)}.seg button:first-child{border-left:0}
.seg button.on{background:var(--ink);color:#fff}
.always{display:flex;align-items:center;gap:10px;padding:16px 24px;border-top:1px solid var(--line);font-size:14px;color:var(--ink-2);background:var(--paper);border-radius:0 0 16px 16px}.always svg{width:17px;height:17px;flex:none}
/* friends, activity */
.friend{display:flex;align-items:center;gap:14px;padding:16px 22px;border-top:1px solid var(--line);font-size:15.5px;font-weight:500}
.friend:first-child{border-top:0}
.friend .avatar{width:38px;height:38px;border-radius:19px;background:var(--paper);color:var(--ink);border:1px solid var(--line);font-size:14px}
.friend .pill{margin-left:auto}
.act-row{display:flex;align-items:flex-start;gap:14px;padding:16px 22px;border-top:1px solid var(--line)}
.act-row:first-child{border-top:0}
.act-row .logo{width:42px;height:42px;border-radius:11px;border:1px solid var(--line);background:var(--paper);display:flex;align-items:center;justify-content:center;color:var(--ink-2);flex:none}.act-row .logo svg{width:19px;height:19px}
.act-row .body{flex:1;min-width:0}
.act-row b{display:block;font-weight:500;font-size:15.5px}
.act-row .sum{display:block;margin-top:2px;font-size:14px;color:var(--ink-2);line-height:1.45}
.act-row .meta{display:flex;flex-direction:column;align-items:flex-end;gap:7px;flex:none}
.act-row .when{font-size:13px;color:var(--ink-3);white-space:nowrap}
.act-row .meta a{display:inline-flex;align-items:center;gap:4px;font-size:13px;color:var(--ink-2);text-decoration:none}.act-row .meta a svg{width:14px;height:14px}
.dayhead{padding:18px 4px 8px;font-size:14.5px;color:var(--ink-2)}
.dayhead:first-child{padding-top:0}
/* coming soon */
.soon{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.soon .card{display:flex;flex-direction:column;align-items:flex-start;padding:20px 22px 18px}
.soon .card b{display:block;font-weight:500;font-size:16px}
.soon .card p{margin-top:6px;font-size:14px;line-height:1.5;color:var(--ink-2)}
.soon .card .pill{margin-bottom:14px}
/* danger */
.danger{padding:22px 24px}
.danger p{font-size:14.5px;line-height:1.55;color:var(--ink-2);max-width:60em}
.danger .act{display:flex;align-items:center;gap:10px;margin-top:16px}
/* rail */
.rail h3{display:flex;align-items:center;gap:10px;font-size:22px;font-weight:500;letter-spacing:-.015em;margin-bottom:18px}.rail h3 svg{width:20px;height:20px;color:var(--ink-2)}
.glance{display:grid;grid-template-columns:1fr 1fr;border-radius:16px;overflow:hidden;border:1px solid var(--line)}
.glance>div{padding:18px 18px 16px;min-height:132px}
.glance .l{background:var(--paper)}
.glance .r{background:var(--blue);color:#fff}
.glance .lab{font-size:14px;color:var(--ink-2)}.glance .r .lab{color:rgba(255,255,255,.8)}
.glance .val{display:block;margin-top:8px;font-size:26px;font-weight:500;letter-spacing:-.02em;line-height:1.1;overflow-wrap:anywhere}
.glance .sub{display:block;margin-top:6px;font-size:13px;color:var(--ink-3)}.glance .r .sub{color:rgba(255,255,255,.8)}
.stat{display:flex;align-items:flex-start;gap:14px;padding:18px 0;border-top:1px solid var(--line);text-decoration:none;color:inherit}
.stat:first-of-type{border-top:0}
.stat .ic{width:40px;height:40px;border-radius:11px;background:var(--paper);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--ink-2);flex:none}.stat .ic svg{width:19px;height:19px}
.stat.live .ic{background:var(--ink);color:#fff;border-color:var(--ink)}
.stat b{display:block;font-weight:500;font-size:16px;line-height:1.3}.stat span{display:block;margin-top:3px;font-size:14px;color:var(--ink-2)}
.stat .go{margin-left:auto;color:var(--ink-3);display:flex}.stat .go svg{width:17px;height:17px}
.rail .stats{margin-top:20px}
.rail hr{border:0;border-top:1px solid var(--line);margin:28px -28px}
@media (max-width:1240px){:root{--rail-w:300px}main{padding:30px 28px 56px}}
@media (max-width:1040px){.cols{grid-template-columns:1fr}.rail{border-left:0;border-top:1px solid var(--line)}}
@media (max-width:820px){.app{grid-template-columns:1fr}.side{position:static;height:auto;padding:12px 14px}.side-bottom{display:none}nav{display:flex;gap:4px;overflow:auto}nav .navhead{display:none}.navitem{height:38px;white-space:nowrap;font-size:14px}.search{display:none}.side-top{padding-bottom:10px}.top{height:64px;padding:0 16px}.top h1{font-size:16px}.btn.text,.btn.soft,.btn.quiet.tall{height:40px;border-radius:12px;font-size:14px;padding:0 14px}main{padding:22px 16px 48px}.hey{font-size:26px}.rail{padding:24px 16px 32px}.soon{grid-template-columns:1fr}.svc,.step{flex-wrap:wrap}.svc .act,.step .act{width:100%;justify-content:flex-end}.rows2 .r{flex-wrap:wrap}}
/* sign in */
.login{max-width:440px;margin:6vh auto 0;padding:32px 30px 28px}
.login h1{margin-top:8px;font-size:26px;line-height:1.2;font-weight:500;letter-spacing:-.02em}
.login .lead{margin-top:10px;font-size:15px;line-height:1.55;color:var(--ink-2)}
.how{list-style:none;margin:22px 0 24px;border-top:1px solid var(--line)}
.how li{display:flex;gap:14px;padding:12px 0;border-bottom:1px solid var(--line);font-size:14.5px}
.how li i{font-family:var(--mono);font-size:11px;color:var(--ink-3);padding-top:3px;width:14px;flex:none}
.login .fine{margin-top:18px;font-size:13px;line-height:1.5;color:var(--ink-3);text-align:center}
.needs{margin-top:16px;padding:12px 14px;border-radius:12px;background:var(--paper);border:1px solid var(--line);font-size:14px;line-height:1.5;color:var(--ink-2)}
.loading{padding:120px 0;text-align:center;color:var(--ink-3);font-size:14px}`;

/** The shell. The sidebar's nav, the top bar and both columns are drawn by the script. */
export function dashboardPage(): string {
  return `<!doctype html><html lang="en"><head>${head("Your account - Jarvis", CSS, `
<meta property="og:title" content="Jarvis - your account"><meta property="og:site_name" content="Jarvis">`)}</head><body>
<div class="app" id="app">
<aside class="side" id="side"><div class="side-top">${BRAND}</div><nav id="nav"></nav><div class="side-bottom" id="sideBottom"></div></aside>
<div class="wrap"><header class="top"><h1 id="title">${ICONS.grid}<span>Home</span></h1><div class="acts" id="acts"></div></header>
<div class="cols"><main id="view"><p class="loading">Loading your account</p></main><aside class="rail" id="rail" hidden></aside></div></div>
</div>
<script src="/dashboard.js"></script></body></html>`;
}
