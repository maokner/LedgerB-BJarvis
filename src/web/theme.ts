/**
 * The one visual system behind every page AgentSign serves: the approval page (src/web/page.ts) and the account
 * page (src/web/dashboard.ts). Paper-white canvas, near-black ink, hairline borders, one typeface, monospace for
 * what the Ledger itself shows. No textures, no glows, no decoration: the content is the design.
 */

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Tokens and the base styles every page starts from. */
export const BASE_CSS = `:root{--paper:#F7F7F5;--card:#FFFFFF;--ink:#111110;--ink-2:#5B5B56;--ink-3:#8E8E88;--line:#E6E6E2;--line-2:#D2D2CC;--ok:#1C7A4C;--bad:#B3261E;--warn:#8A6100;--accent:#FF5300;--radius:14px;--font:Inter,-apple-system,system-ui,"Segoe UI",sans-serif;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace}
*{box-sizing:border-box;margin:0;padding:0}[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%}
body{font-family:var(--font);font-size:15px;line-height:1.5;background:var(--paper);color:var(--ink);min-height:100dvh;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:"cv11","ss01"}
a{color:inherit}
button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
button:disabled{cursor:default}
:focus-visible{outline:2px solid var(--ink);outline-offset:3px;border-radius:4px}
.mono{font-family:var(--mono);font-feature-settings:normal}
.eyebrow{font-family:var(--mono);font-size:11.5px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3)}
.eyebrow.good{color:var(--ok)}.eyebrow.bad{color:var(--bad)}.eyebrow.live{color:var(--ink-2)}
.brand{display:inline-flex;align-items:center;gap:10px;font-size:16px;font-weight:600;letter-spacing:-.01em;color:var(--ink);text-decoration:none}
.brand img{height:30px;width:auto;flex:none}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;height:44px;padding:0 18px;border-radius:11px;background:var(--ink);color:#fff;font-size:14.5px;font-weight:500;letter-spacing:-.005em;text-decoration:none;white-space:nowrap;transition:background .15s,opacity .15s}
.btn:hover{background:#000}.btn:disabled{opacity:.45}
.btn.block{width:100%;height:52px;font-size:15px}
.btn.quiet{background:var(--card);color:var(--ink);border:1px solid var(--line-2)}.btn.quiet:hover{background:var(--paper)}
.btn.danger{background:var(--card);color:var(--bad);border:1px solid var(--line-2)}.btn.danger:hover{border-color:var(--bad);background:#fff}
.btn.sm{height:34px;padding:0 13px;font-size:13px;border-radius:9px}
.btn svg{width:18px;height:18px;flex:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius)}
.link{color:var(--ink);text-decoration:underline;text-decoration-color:var(--line-2);text-underline-offset:3px}.link:hover{text-decoration-color:var(--ink)}
.muted{color:var(--ink-2)}.subtle{color:var(--ink-3)}
.pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;border:1px solid var(--line);font-size:12px;font-weight:500;color:var(--ink-2);white-space:nowrap}
.pill:before{content:"";width:6px;height:6px;border-radius:3px;background:var(--line-2)}
.pill.on{color:var(--ok);border-color:#CFE5D8}.pill.on:before{background:var(--ok)}
.pill.off{color:var(--ink-3)}.pill.soon{color:var(--ink-3);border-style:dashed}.pill.soon:before{display:none}
.pill.wait{color:var(--warn);border-color:#E8D9B0}.pill.wait:before{background:var(--warn)}
.pill.bad{color:var(--bad);border-color:#EBC9C6}.pill.bad:before{background:var(--bad)}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}`;

/** The shared <head>: viewport, no referrer, the typeface, and the base styles plus `css`. */
export function head(title: string, css: string, extra = ""): string {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#F7F7F5">
<link rel="icon" href="/jarvis.png" type="image/png">
<title>${esc(title)}</title>${extra}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>${BASE_CSS}
${css}</style>`;
}

/** The eyebrow's colour class per action status (the approval page renders it, its script updates it). */
export const TONE: Record<string, string> = { pending: "live", approved: "live", executed: "good", rejected: "bad", expired: "bad", failed: "bad" };

/** The wordmark: the Jarvis robot (src/web/jarvis.png, served at /jarvis.png) and the name. */
export const BRAND = `<a class="brand" href="/"><img src="/jarvis.png" alt="" width="18" height="30">Jarvis</a>`;

/** Monochrome line icons, 24-unit grid, drawn with currentColor. */
export const ICONS = {
  ledger: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7.5" width="18" height="9" rx="2.5"/><path d="M7 10.5h5.5v3H7zM17 10.5v3"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 3.5h3l1.5 4-2 1.5a11 11 0 0 0 6 6l1.5-2 4 1.5v3a2 2 0 0 1-2 2A15 15 0 0 1 4.5 5.5a2 2 0 0 1 2-2z"/></svg>`,
  chat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V17H6.5A2.5 2.5 0 0 1 4 14.5z"/></svg>`,
  cart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 4.5h2l2.2 11h10.6l2.2-7.5H7"/><circle cx="9" cy="19.5" r="1.3"/><circle cx="17" cy="19.5" r="1.3"/></svg>`,
  bowl: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 11.5h17a8.5 8.5 0 0 1-17 0z"/><path d="M8 20h8M12 4v3M8.5 5l1 2M15.5 5l-1 2"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l7 2.5v6c0 4.3-3 7.4-7 8.5-4-1.1-7-4.2-7-8.5V6z"/><path d="M9 12l2 2 4-4.5"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M9 7h8v8"/></svg>`,
  copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M5.5 15.5h-1a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`,
  base: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h11" stroke-linecap="round"/></svg>`,
  friends: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="16.5" cy="9.5" r="2.4"/><path d="M15.5 14.8a4.5 4.5 0 0 1 5 4.2"/></svg>`,
  activity: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/></svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11l8-7 8 7v8.5a1.5 1.5 0 0 1-1.5 1.5H14v-6h-4v6H5.5A1.5 1.5 0 0 1 4 19.5z"/></svg>`,
  grid: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/></svg>`,
  gift: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7M12 8.5v12M12 8.5c-2-3-5-3.5-5-1.5s3 1.5 5 1.5zm0 0c2-3 5-3.5 5-1.5s-3 1.5-5 1.5z"/></svg>`,
  logout: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10M15 8l4 4-4 4M9 12h10"/></svg>`,
  spark: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>`,
  bubble: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3C6.5 3 2 6.8 2 11.4c0 2.6 1.4 4.9 3.6 6.4-.2 1.3-.8 2.6-1.6 3.6 2 0 3.9-.8 5.3-1.9 .9.2 1.8.3 2.7.3 5.5 0 10-3.8 10-8.4S17.5 3 12 3z"/></svg>`,
} as const;
