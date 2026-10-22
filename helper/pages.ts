// The helper's own pages, served on http://127.0.0.1:<port>. Plain HTML, no scripts, nothing loaded
// from anywhere: the approval page must be something no website can read, script or click.

import type { Pairing, PairedSite } from "./auth";
import type { Activity } from "./server";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const LOGO = `<svg width="28" height="28" viewBox="0 0 36 36" fill="none" aria-hidden="true"><defs><linearGradient id="g" x1="6" y1="5" x2="30" y2="31" gradientUnits="userSpaceOnUse"><stop stop-color="#19c9bb"/><stop offset="0.55" stop-color="#46b6ff"/><stop offset="1" stop-color="#8b6dff"/></linearGradient></defs><rect x="3" y="3" width="30" height="30" rx="11" fill="url(#g)" stroke="#0d0f14" stroke-width="2.4"/><path d="M25 12.5 A 8 8 0 1 0 25 23.5 c 5.2 0 6.2 -4.2 1.4 -5.2" stroke="#fff" stroke-width="4" stroke-linecap="round" fill="none"/><circle cx="25" cy="12.5" r="3.6" fill="#fff" stroke="#0d0f14" stroke-width="1.6"/><circle cx="26.1" cy="12.5" r="1.6" fill="#0d0f14"/></svg>`;

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Clearcote Helper</title>
<style>
:root{color-scheme:light;--paper:#FBFAF5;--card:#fff;--ink:#0D0F14;--body:#454B56;--muted:#5B616C;--line:rgba(13,15,20,.1);--teal:#0E7D72;--ok:#047857;--bad:#B42318}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 Inter,"Segoe UI",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:40px 16px 64px}
header{display:flex;align-items:center;gap:10px;margin-bottom:28px;font-weight:600}header span{color:var(--muted)}
h1{font-size:26px;line-height:1.2;margin:0 0 8px;letter-spacing:-.01em}h2{font-size:17px;margin:32px 0 12px}
p{margin:0 0 12px;color:var(--body)}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:24px}
.code{font:600 40px/1.1 "JetBrains Mono",Consolas,monospace;letter-spacing:.08em;margin:8px 0 4px}
.origin{font:500 15px "JetBrains Mono",Consolas,monospace;background:#F2EFE5;border-radius:8px;padding:2px 8px}
.row{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
button{font:inherit;font-weight:600;min-height:44px;padding:0 18px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:10px 8px;border-top:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:600;border-top:0}
.muted{color:var(--muted);font-size:13px}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}
a{color:var(--teal)}
</style></head><body><main><header>${LOGO}<div>Clear<span>cote</span> Helper</div></header>${body}</main></body></html>`;
}

const when = (iso?: string) => (iso ? esc(new Date(iso).toLocaleString()) : "never");

export function pairPage({ pairing, secret }: { pairing?: Pairing; secret: string }): string {
  if (!pairing) return shell("Pairing", `<h1>This request is gone</h1><p>It expired or was already answered. Start again from the web page.</p><p><a href="/">Back to the helper</a></p>`);
  if (pairing.status !== "pending") {
    const msg =
      pairing.status === "approved"
        ? `<h1 class="ok">Paired</h1><p>${esc(pairing.origin)} can now start your browsers. You can close this tab and go back to it.</p>`
        : pairing.status === "denied"
          ? `<h1 class="bad">Denied</h1><p>Nothing was paired.</p>`
          : `<h1>Expired</h1><p>Start again from the web page.</p>`;
    return shell("Pairing", `${msg}<p><a href="/">See paired sites</a></p>`);
  }
  return shell(
    "Approve pairing",
    `<h1>Let this site start your browsers?</h1>
<p><span class="origin">${esc(pairing.origin)}</span> (“${esc(pairing.name)}”) asks to use the Clearcote helper on this computer.</p>
<div class="card">
<div class="muted">Check that the web page shows this same code</div>
<div class="code">${esc(pairing.code)}</div>
<p class="muted">Only approve if you opened the Clearcote profile manager yourself just now and the codes match.</p>
<p class="muted">Once paired, that site can list, create, change, launch and stop your Clearcote profiles on this computer, and change their proxies and settings. It cannot choose which program the helper runs, pass browser switches that run programs, move profile data to other folders, or read your licence and API keys back. You can remove its access here at any time.</p>
<form method="post" action="/local/pair" class="row">
<input type="hidden" name="secret" value="${esc(secret)}"><input type="hidden" name="id" value="${esc(pairing.id)}">
<button class="primary" name="decision" value="approve">Codes match: approve</button>
<button name="decision" value="deny">Deny</button>
</form>
</div>`,
  );
}

export function statusPage(o: { version: string; sites: PairedSite[]; pending: Pairing[]; activity: Activity[]; secret: string }): string {
  const pending = o.pending.length
    ? `<h2>Waiting for you</h2>${o.pending.map((p) => `<p><a href="/pair/${esc(p.id)}">${esc(p.origin)} wants to pair (code ${esc(p.code)})</a></p>`).join("")}`
    : "";
  const sites = o.sites.length
    ? `<table><tr><th>Site</th><th>Name</th><th>Paired</th><th>Last used</th><th></th></tr>${o.sites
        .map(
          (s) => `<tr><td>${esc(s.origin)}</td><td>${esc(s.name)}</td><td>${when(s.createdAt)}</td><td>${when(s.lastUsedAt)}</td>
<td><form method="post" action="/local/revoke"><input type="hidden" name="secret" value="${esc(o.secret)}"><input type="hidden" name="hash" value="${esc(s.hash)}"><button>Remove</button></form></td></tr>`,
        )
        .join("")}</table>`
    : `<p class="muted">No site is paired yet.</p>`;
  const act = o.activity.length
    ? `<table><tr><th>When</th><th>Site</th><th>What</th></tr>${o.activity
        .slice(0, 50)
        .map((a) => `<tr><td>${when(a.at)}</td><td>${esc(a.origin)}</td><td>${esc(a.what)}</td></tr>`)
        .join("")}</table>`
    : `<p class="muted">Nothing yet in this run.</p>`;
  return shell(
    "Status",
    `<h1>The helper is running</h1>
<p>It lets the Clearcote web profile manager start the Clearcote browser on this computer. Version ${esc(o.version)}.
The source is at <a href="https://github.com/clearcotelabs/clearcote-profile-manager/tree/main/helper">github.com/clearcotelabs/clearcote-profile-manager</a>.</p>
${pending}
<h2>Sites that can use it</h2>${sites}
<h2>Recent activity</h2>${act}`,
  );
}
