"use client";

// A profile's current 2FA code, live: the code (in two groups, easy to read off), a ring that empties as it runs out,
// and a copy button. It works the code out itself every second from the secret (electron/totp.ts), so it is the code a
// site accepts right now. Copying near the end of a window copies the next code, as a task would type it.

import { useEffect, useState } from "react";
import { groupCode, parseTotp, totpNow, totpToType } from "../../electron/totp";
import { t } from "@/lib/i18n";

/** The code to copy: this window's, or the next one in its last seconds (electron/totp.ts totpToType). */
export const totpToCopy = (secret: string) => totpToType(secret);

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function TotpCode({ secret, compact, label }: { secret: string; compact?: boolean; label?: string }) {
  const parsed = parseTotp(secret);
  const [now, setNow] = useState<{ code: string; left: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const spec = parsed.ok ? parsed.spec : null;
  const key = spec ? `${spec.secret}/${spec.digits}/${spec.period}/${spec.algorithm}` : "";

  useEffect(() => {
    if (!spec) return;
    let alive = true;
    const tick = () =>
      void totpNow(spec).then((r) => {
        if (alive) setNow({ code: r.code, left: r.secondsLeft });
      });
    tick();
    const id = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!spec) return <span className="text-[11px] text-danger">{t("2FA secret not readable")}</span>;
  const frac = now ? now.left / spec.period : 1;
  const low = now ? now.left <= 5 : false;
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span className="inline-flex items-center gap-1.5" data-totp>
      <span
        className={"font-mono tabular-nums tracking-wider " + (compact ? "text-[12px] " : "text-[15px] ") + (low ? "text-warn" : "text-fog")}
        data-totp-code={now?.code ?? ""}
        aria-label={label ?? t("2FA code")}
      >
        {now ? groupCode(now.code) : "··· ···"}
      </span>
      <svg viewBox="0 0 18 18" className={compact ? "h-3.5 w-3.5" : "h-4 w-4"} aria-hidden>
        <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.5" className="stroke-line" />
        <circle
          cx="9"
          cy="9"
          r={r}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className={low ? "stroke-warn" : "stroke-accent"}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - frac)}
          transform="rotate(-90 9 9)"
        />
      </svg>
      {!compact && now && <span className="text-[10px] tabular-nums text-fog/40">{t("{n} s", { n: now.left })}</span>}
      <button
        type="button"
        className="rounded-md border border-line px-1.5 py-px text-[10px] font-medium text-fog/70 hover:bg-elevate hover:text-fog"
        onClick={async (e) => {
          e.stopPropagation();
          const code = await totpToCopy(secret);
          if (code && (await copyText(code))) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        aria-label={t("Copy the 2FA code")}
        data-totp-copy
      >
        {copied ? t("Copied") : t("Copy")}
      </button>
    </span>
  );
}
