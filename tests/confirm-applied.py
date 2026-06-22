#!/usr/bin/env python3
"""Runtime confirmation: launch the Clearcote binary with every profile setting set to a
distinctive value and probe the matching in-page surface to confirm each is actually applied.

This is the end-to-end counterpart to the vitest unit tests (which check the profile-manager emits
the right switches). It needs the real Windows binary, so it does NOT run in CI:

    pip install playwright
    CLEARCOTE_BINARY=/path/to/clearcote/chrome.exe  python tests/confirm-applied.py

Findings (Chromium 149 build): platform, brand, hardwareConcurrency, timezone, language, webrtcIp,
gpuVendor / gpuRenderer, location and (separately) imported fingerprint-profiles all apply.
gpuVendor / gpuRenderer + location were KNOWN ENGINE GAPS until clearcote-browser commit d7bbe67
wired --fingerprint-gpu-vendor/-renderer + --fingerprint-location (ships v0.1.0-pre.10+) — so run
this against a pre.10+ binary. One REMAINING gap: navigator.languages keeps only the primary tag
(the full-array surface is not implemented yet). See tests/README.md.
"""
import os
import sys

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sys.exit("pip install playwright")

CHROME = os.environ.get("CLEARCOTE_BINARY") or os.path.join(
    os.path.dirname(__file__), "..", "..", "win-x64", "chrome.exe")
if not os.path.exists(CHROME):
    sys.exit(f"Clearcote binary not found at {CHROME} (set CLEARCOTE_BINARY).")

P = dict(fingerprint="confirm-seed-001", platform="windows", brand="chrome",
         gpuVendor="Google Inc. (NVIDIA)",
         gpuRenderer="ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)",
         hardwareConcurrency=24, timezone="Asia/Tokyo", acceptLanguage="fr-FR,fr",
         location="35.6762,139.6503", webrtcIp="203.0.113.7")
ARGS = [
    f"--fingerprint={P['fingerprint']}", f"--fingerprint-platform={P['platform']}",
    f"--fingerprint-brand={P['brand']}", f"--fingerprint-gpu-vendor={P['gpuVendor']}",
    f"--fingerprint-gpu-renderer={P['gpuRenderer']}",
    f"--fingerprint-hardware-concurrency={P['hardwareConcurrency']}",
    f"--timezone={P['timezone']}", f"--accept-lang={P['acceptLanguage']}",
    f"--fingerprint-location={P['location']}", f"--webrtc-ip={P['webrtcIp']}",
    "--no-first-run", "--no-default-browser-check", "--no-sandbox",
]

PROBE = r"""async () => {
  const o = {};
  o.platform = navigator.platform;
  o.uaPlatform = navigator.userAgentData ? navigator.userAgentData.platform : null;
  o.brands = navigator.userAgentData ? navigator.userAgentData.brands.map(b => b.brand) : [];
  o.hardwareConcurrency = navigator.hardwareConcurrency;
  o.language = navigator.language; o.languages = navigator.languages;
  o.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  o.tzOffset = new Date('2026-01-15T12:00:00Z').getTimezoneOffset();
  try { const gl = document.createElement('canvas').getContext('webgl');
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    o.glVendor = gl.getParameter(d.UNMASKED_VENDOR_WEBGL);
    o.glRenderer = gl.getParameter(d.UNMASKED_RENDERER_WEBGL); } catch (e) { o.glErr = String(e); }
  o.geo = await new Promise(res => { try { navigator.geolocation.getCurrentPosition(
    p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
    e => res({ err: e.message }), { timeout: 5000 }); } catch (e) { res({ err: String(e) }); } });
  o.webrtc = await new Promise(res => {
    const cands = [];
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pc.createDataChannel('x');
    pc.onicecandidate = e => { if (e.candidate) cands.push(e.candidate.candidate); else
      res(cands.some(c => c.includes('203.0.113.7')) ? '203.0.113.7' : 'no-match'); };
    pc.createOffer().then(off => pc.setLocalDescription(off));
    setTimeout(() => res(cands.some(c => c.includes('203.0.113.7')) ? '203.0.113.7' : 'timeout'), 8000);
  });
  return o;
}"""

with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=CHROME, headless=False, args=ARGS,
                           ignore_default_args=["--enable-automation"], timeout=60000)
    ctx = b.new_context(); ctx.grant_permissions(["geolocation"])
    page = ctx.new_page(); page.goto("https://example.com", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_timeout(300)
    r = page.evaluate(PROBE); b.close()

geo = r.get("geo") or {}
# (label, applied?, known-engine-gap?)
rows = [
    ("platform → navigator.platform", r["platform"] == "Win32", False),
    ("platform → UA-CH platform", r["uaPlatform"] == "Windows", False),
    ("brand → UA-CH brands", "Google Chrome" in r["brands"], False),
    ("hardwareConcurrency", r["hardwareConcurrency"] == 24, False),
    ("timezone → Intl timeZone", r["timezone"] == "Asia/Tokyo", False),
    ("timezone → Date offset (JST -540)", r["tzOffset"] == -540, False),
    ("acceptLanguage → navigator.language", r["language"] == "fr-FR", False),
    ("webrtcIp → srflx candidate", r.get("webrtc") == "203.0.113.7", False),
    # navigator.languages full array is the one remaining engine gap (only the primary tag applies).
    ("acceptLanguage → navigator.languages (full list)", r["languages"] == ["fr-FR", "fr"], True),
    # Fixed in clearcote-browser d7bbe67 (pre.10+): these now apply, no longer KNOWN ENGINE GAPS.
    ("gpuVendor → WebGL UNMASKED_VENDOR", r.get("glVendor") == P["gpuVendor"], False),
    ("gpuRenderer → WebGL UNMASKED_RENDERER", "RTX 4090" in (r.get("glRenderer") or ""), False),
    ("location → geolocation", abs((geo.get("lat") or 0) - 35.6762) < 0.01, False),
]
print("Runtime confirmation — settings applied in the launched browser:\n")
unexpected = 0
for label, ok, known_gap in rows:
    if ok:
        tag = "APPLIED"
    elif known_gap:
        tag = "not applied (KNOWN ENGINE GAP)"
    else:
        tag = "FAIL"; unexpected += 1
    print(f"  [{tag:30}] {label}")
print("\n" + ("OK — all applied except the documented engine gaps."
             if unexpected == 0 else f"{unexpected} UNEXPECTED failure(s)."))
sys.exit(1 if unexpected else 0)
