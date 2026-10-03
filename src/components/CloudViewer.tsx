"use client";

// The window that shows one profile's cloud browser and drives it.
//
// The main process holds the API key; this window asks it for a 60-second live-view URL
// (api.cloud.viewUrl), opens that WebSocket itself, draws the JPEG frames it sends and returns the
// person's mouse, wheel, keys, pasted text and address bar as the worker's small JSON events
// (src/lib/liveinput.ts). A dropped view reconnects with a fresh URL while the session lives; when the
// service ends the session, the window says why and what it cost.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CloudEnded, type CloudSession } from "@/lib/ipc";
import { framePoint, keyEvent, modifiers, mouseButton, navTo, parseLiveText, reconnectDelay, wheelPixels } from "@/lib/liveinput";
import { endReasonText, formatBytes, formatDuration, formatEur } from "../../electron/cloudtext";
import { useConfirm } from "./Confirm";

type Phase = "connecting" | "live" | "reconnecting" | "ended" | "missing";

const iconBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fog/60 hover:bg-elevate hover:text-fog disabled:opacity-30 disabled:hover:bg-transparent";

export default function CloudViewer({ profileId }: { profileId: string }) {
  const confirm = useConfirm();
  const [session, setSession] = useState<CloudSession | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [ended, setEnded] = useState<CloudEnded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [control, setControl] = useState(false);
  const [meta, setMeta] = useState<{ url: string; title: string; tabs: number } | null>(null);
  const [address, setAddress] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [stopping, setStopping] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const lastUrl = useRef<string | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const moveQueued = useRef<{ x: number; y: number; m: number } | null>(null);
  const endedRef = useRef(false);

  const send = useCallback((m: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify(m));
  }, []);

  // ── the session: what it is, how much it used, whether it ended ──────────────────────────────
  useEffect(() => {
    let alive = true;
    const pick = (list: CloudSession[]) => list.find((s) => s.profileId === profileId) ?? null;
    void api.cloud.list().then((l) => {
      if (!alive) return;
      const s = pick(l);
      setSession(s);
      if (!s) setPhase("missing");
    });
    const offChanged = api.cloud.onChanged((l) => {
      const s = pick(l);
      if (s) setSession(s);
    });
    const offEnded = api.cloud.onEnded((ev) => {
      if (ev.profileId !== profileId) return;
      endedRef.current = true;
      setEnded(ev);
      setPhase("ended");
      ws.current?.close();
    });
    return () => {
      alive = false;
      offChanged();
      offEnded();
    };
  }, [profileId]);

  // The tab title names the profile. Next writes the app's metadata title after the page loads, so
  // put it back whenever the head changes.
  useEffect(() => {
    if (!session?.name) return;
    const want = `${session.name} — Cloud`;
    const apply = () => {
      if (document.title !== want) document.title = want;
    };
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => mo.disconnect();
  }, [session?.name]);

  // ── the live view socket, reconnecting with a fresh URL while the session lives ─────────────────
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const open = async () => {
      if (cancelled || endedRef.current) return;
      const r = await api.cloud.viewUrl(profileId, true);
      if (cancelled) return;
      if (!r.ok) {
        if (r.ended) {
          endedRef.current = true;
          setPhase("ended");
          return;
        }
        setError(r.error);
        setPhase("reconnecting");
        timer = setTimeout(open, reconnectDelay(attempt++));
        return;
      }
      setError(null);
      const sock = new WebSocket(r.viewUrl);
      sock.binaryType = "blob";
      ws.current = sock;
      sock.onopen = () => {
        attempt = 0;
        setPhase("live");
      };
      sock.onmessage = (e) => {
        if (typeof e.data === "string") {
          const t = parseLiveText(e.data);
          if (t.kind === "hello") setControl(t.control && r.interactive);
          else if (t.kind === "meta") setMeta(t);
          return;
        }
        const url = URL.createObjectURL(e.data as Blob);
        if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
        lastUrl.current = url;
        setSrc(url);
      };
      sock.onclose = () => {
        if (ws.current === sock) ws.current = null;
        setControl(false);
        if (cancelled || endedRef.current) return;
        setPhase("reconnecting");
        timer = setTimeout(open, reconnectDelay(attempt++));
      };
    };
    void open();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      ws.current?.close();
      ws.current = null;
    };
    // Reconnect only when a session appears, not on every usage update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, !!session]);

  useEffect(() => () => {
    if (lastUrl.current) URL.revokeObjectURL(lastUrl.current);
  }, []);

  useEffect(() => {
    if (!editingAddress && meta?.url) setAddress(meta.url);
  }, [meta?.url, editingAddress]);

  // ── input (only while the worker granted control) ───────────────────────────────────────────────
  const point = (e: { clientX: number; clientY: number }) => {
    const el = img.current;
    if (!el) return null;
    return framePoint(e.clientX, e.clientY, el.getBoundingClientRect(), { width: el.naturalWidth, height: el.naturalHeight });
  };
  const onMouse = (type: "down" | "up") => (e: React.MouseEvent) => {
    if (!control) return;
    e.preventDefault();
    if (type === "down") stage.current?.focus();
    const p = point(e);
    if (!p) return;
    send({ t: "mouse", e: type, x: p.x, y: p.y, b: mouseButton(e.button), n: Math.min(3, Math.max(1, e.detail || 1)), m: modifiers(e) });
  };
  const onMove = (e: React.MouseEvent) => {
    if (!control) return;
    const p = point(e);
    if (!p) return;
    // At most one move per animation frame: enough for hover menus and drags, not a flood.
    const queued = moveQueued.current;
    moveQueued.current = { ...p, m: modifiers(e) };
    if (queued) return;
    requestAnimationFrame(() => {
      const q = moveQueued.current;
      moveQueued.current = null;
      if (q) send({ t: "mouse", e: "move", x: q.x, y: q.y, m: q.m });
    });
  };
  useEffect(() => {
    const el = stage.current;
    if (!el || !control) return;
    const onWheel = (e: WheelEvent) => {
      const p = point(e);
      if (!p) return;
      e.preventDefault();
      send({ t: "wheel", x: p.x, y: p.y, dx: wheelPixels(e.deltaX, e.deltaMode), dy: wheelPixels(e.deltaY, e.deltaMode), m: modifiers(e) });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [control, send]);
  const onKey = (type: "down" | "up") => (e: React.KeyboardEvent) => {
    if (!control) return;
    const k = keyEvent(type, e);
    if (!k) return;
    e.preventDefault();
    send(k);
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (!control) return;
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    send({ t: "text", text: text.slice(0, 5000) });
  };
  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const m = navTo(address);
    if (!m) return;
    send(m);
    setEditingAddress(false);
    stage.current?.focus();
  };

  async function stop() {
    const ok = await confirm({
      title: "Stop this cloud browser?",
      body: "It closes on Clearcote's servers. Its cookies are kept when the profile keeps them; anything open is lost.",
      confirmLabel: "Stop",
      tone: "danger",
    });
    if (!ok) return;
    setStopping(true);
    const r = await api.cloud.stop(profileId);
    setStopping(false);
    if (!r.ok) setError(r.error ?? "It could not be stopped. Try again.");
  }

  // ── what is shown ──────────────────────────────────────────────────────────────────────────────
  if (phase === "missing") {
    return (
      <Centered>
        <p className="text-sm text-fog/70">This profile is not running in the cloud.</p>
        <button className="mt-3 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fog/80 hover:bg-elevate" onClick={() => window.close()}>
          Close window
        </button>
      </Centered>
    );
  }

  const usage = session ? `${session.exit ?? "cloud"} · ${formatBytes(session.bytes)} · ${formatEur(session.costEur)}${session.seconds ? ` · ${formatDuration(session.seconds)}` : ""}` : "";

  return (
    <div className="flex h-screen flex-col bg-ink text-fog">
      <header className="flex items-center gap-1.5 border-b border-line bg-surface/80 px-2 py-1.5 text-xs">
        <span
          aria-hidden
          className={`mx-1 h-2 w-2 shrink-0 rounded-full ${phase === "live" ? "animate-pulse bg-danger" : phase === "ended" ? "bg-fog/30" : "bg-warn"}`}
        />
        <button type="button" className={iconBtn} aria-label="Back" disabled={!control} onClick={() => send({ t: "nav", a: "back" })}>
          ←
        </button>
        <button type="button" className={iconBtn} aria-label="Forward" disabled={!control} onClick={() => send({ t: "nav", a: "forward" })}>
          →
        </button>
        <button type="button" className={iconBtn} aria-label="Reload" disabled={!control} onClick={() => send({ t: "nav", a: "reload" })}>
          ↻
        </button>
        <form onSubmit={go} className="min-w-0 flex-1">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={() => setEditingAddress(true)}
            onBlur={() => setEditingAddress(false)}
            aria-label="Address"
            spellCheck={false}
            disabled={!control}
            placeholder={phase === "live" ? "" : "Connecting…"}
            className="h-7 w-full rounded-md border border-line bg-ink/70 px-2 font-mono text-[12px] text-fog outline-none focus:border-accent/60"
          />
        </form>
        {meta && meta.tabs > 1 && <span className="shrink-0 px-1 text-fog/45">{meta.tabs} tabs</span>}
        <span data-cloud-viewer-usage className="hidden shrink-0 truncate px-2 text-fog/50 md:inline" title={session ? `Cloud session ${session.sid}` : undefined}>
          {usage}
        </span>
        <button
          type="button"
          onClick={() => void stop()}
          disabled={stopping || phase === "ended" || session?.status === "stopping"}
          className="shrink-0 rounded-md border border-line-strong px-2.5 py-1 font-semibold text-fog/85 hover:bg-elevate disabled:opacity-40"
        >
          {stopping || session?.status === "stopping" ? "Stopping…" : "Stop"}
        </button>
      </header>

      {phase !== "ended" &&
        (session?.status === "stopping" ? (
          <p role="status" className="border-b border-line bg-warn/10 px-3 py-1.5 text-xs text-warn">
            Stopping. Its server closes it within a few seconds.
          </p>
        ) : (
          (error || phase === "reconnecting") && (
            <p role="status" className="border-b border-line bg-warn/10 px-3 py-1.5 text-xs text-warn">
              {error ? `${error} Reconnecting…` : "The live view dropped. Reconnecting…"}
            </p>
          )
        ))}

      <div
        ref={stage}
        data-cloud-stage
        tabIndex={0}
        onMouseDown={onMouse("down")}
        onMouseUp={onMouse("up")}
        onMouseMove={onMove}
        onContextMenu={(e) => control && e.preventDefault()}
        onKeyDown={onKey("down")}
        onKeyUp={onKey("up")}
        onPaste={onPaste}
        className={`relative min-h-0 flex-1 bg-black outline-none ${control ? "cursor-default" : ""}`}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img ref={img} src={src} alt={meta?.title ? `Cloud browser showing ${meta.title}` : "Cloud browser"} draggable={false} className="h-full w-full select-none object-contain" />
        ) : (
          phase !== "ended" && (
            <Centered>
              <span className="text-sm text-fog/55">{phase === "reconnecting" ? "Reconnecting to the cloud browser…" : "Connecting to the cloud browser…"}</span>
            </Centered>
          )
        )}
        {phase === "ended" && (
          <div role="status" className="absolute inset-0 flex items-center justify-center bg-ink/80 p-6">
            <div className="max-w-md rounded-xl border border-line bg-surface p-5 text-sm">
              <p className="font-semibold text-fog">The cloud browser ended</p>
              <p className="mt-1.5 text-fog/65">{endReasonText(ended?.reason ?? null, ended?.status)}</p>
              {ended && (ended.bytes != null || ended.costEur != null) && (
                <p className="mt-1 text-fog/50">
                  It used {formatBytes(ended.bytes)} and cost {formatEur(ended.costEur)}.
                </p>
              )}
              <button
                className="mt-4 rounded-lg border border-line-strong px-3 py-1.5 text-xs font-medium text-fog/85 hover:bg-elevate"
                onClick={() => window.close()}
              >
                Close window
              </button>
            </div>
          </div>
        )}
      </div>
      {control && phase === "live" && (
        <p className="border-t border-line bg-surface/60 px-3 py-1 text-[11px] text-fog/40">
          Click the page to type into it. Paste with Ctrl+V. Closing this window does not stop the cloud browser.
        </p>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full min-h-[200px] flex-col items-center justify-center p-6 text-center">{children}</div>;
}
