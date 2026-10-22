// Makes public/og.png, the 1200×630 image link previews show (X/Twitter, LinkedIn, Slack, …):
// the headline beside a real screenshot of the web version's preview.
//
//   npm run web:build && npx serve out -l 8090      (any static server)
//   CHROME=/path/to/chrome node scripts/make-og.mjs http://localhost:8090/
//
// Headless only. Run it again when the app's look changes.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] || "http://localhost:8090/";
const executablePath = process.env.CHROME;
if (!executablePath) throw new Error("Set CHROME to a Chromium/Chrome binary.");

const logo = `<svg viewBox="0 0 36 36" width="64" height="64" fill="none"><defs><linearGradient id="g" x1="6" y1="5" x2="30" y2="31" gradientUnits="userSpaceOnUse"><stop stop-color="#19c9bb"/><stop offset="0.55" stop-color="#46b6ff"/><stop offset="1" stop-color="#8b6dff"/></linearGradient></defs><rect x="3" y="3" width="30" height="30" rx="11" fill="url(#g)" stroke="#0d0f14" stroke-width="2.4"/><path d="M25 12.5 A 8 8 0 1 0 25 23.5 c 5.2 0 6.2 -4.2 1.4 -5.2" stroke="#fff" stroke-width="4" stroke-linecap="round" fill="none"/><circle cx="25" cy="12.5" r="3.6" fill="#fff" stroke="#0d0f14" stroke-width="1.6"/><circle cx="26.1" cy="12.5" r="1.6" fill="#0d0f14"/></svg>`;

const card = (shot) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;overflow:hidden;background:#07080a;color:#e6e9ee;font-family:Inter,sans-serif;position:relative}
.glow{position:absolute;inset:0;background:radial-gradient(600px 400px at 85% 10%,rgba(56,224,214,.18),transparent 70%),radial-gradient(500px 380px at 100% 100%,rgba(167,139,250,.16),transparent 70%)}
.left{position:absolute;left:72px;top:72px;width:520px}
.brand{display:flex;align-items:center;gap:16px;font-size:28px;font-weight:600}
.brand span{color:#8b919c}
h1{margin-top:44px;font-size:62px;line-height:1.04;font-weight:800;letter-spacing:-.025em}
h1 em{font-style:normal;background:linear-gradient(135deg,#38e0d6,#6ee7ff 55%,#a78bfa);-webkit-background-clip:text;color:transparent}
p{margin-top:26px;font-size:25px;line-height:1.4;color:#b8bec8}
.url{position:absolute;left:72px;bottom:64px;font-size:24px;font-weight:600;color:#38e0d6}
.shot{position:absolute;left:640px;top:96px;width:720px;border-radius:18px;border:1px solid rgba(255,255,255,.14);box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden}
.shot img{display:block;width:100%}
</style></head><body><div class="glow"></div>
<div class="left">
<div class="brand">${logo}<div>Clear<span>cote</span> Profile Manager</div></div>
<h1>Launch your browser profiles <em>from the web</em></h1>
<p>Profiles stay on your computer. A small open-source helper starts the browser.</p>
</div>
<div class="url">app.clearcotelabs.com</div>
<div class="shot"><img src="data:image/png;base64,${shot.toString("base64")}"></div>
</body></html>`;

const browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
try {
  const app = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await app.goto(url, { waitUntil: "networkidle" });
  await app.getByText("Online shop — seller account").waitFor({ timeout: 20000 });
  // The app itself, below the preview bar.
  const shot = await app.screenshot({ clip: { x: 150, y: 72, width: 1140, height: 640 } });
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(card(shot), { waitUntil: "networkidle" });
  const out = path.join(ROOT, "public", "og.png");
  fs.writeFileSync(out, await page.screenshot({ type: "png" }));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
