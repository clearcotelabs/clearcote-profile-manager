"use client";

// The 2FA secret in the profile editor: hidden by default (it signs in as the account), Show to check it, and once it
// reads as a secret the live code beside it, so it can be checked against the site's own or an authenticator app.
// Accepts base32 as sites show it (spaces and case don't matter) or the otpauth:// link inside the QR code.

import { useState } from "react";
import { parseTotp } from "../../electron/totp";
import { t, tx } from "@/lib/i18n";
import TotpCode from "./TotpCode";

// parseTotp's messages (electron/totp.ts), marked so they are translated.
export const TOTP_ERRORS = [
  tx("No 2FA secret."),
  tx("That otpauth:// link could not be read."),
  tx("Only time-based codes (otpauth://totp/…) are supported."),
  tx("A 2FA secret is base32: letters A–Z and digits 2–7."),
  tx("That secret is too short to be a 2FA key (at least 16 characters)."),
  tx("A 2FA code has 6 to 8 digits and changes every 10 to 300 seconds."),
];

const input =
  "w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 font-mono";

export default function TotpField({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [show, setShow] = useState(false);
  const v = value ?? "";
  const parsed = v.trim() ? parseTotp(v) : null;
  return (
    <div data-totp-field>
      <div className="flex gap-2">
        <input
          className={input}
          type={show ? "text" : "password"}
          value={v}
          autoComplete="off"
          spellCheck={false}
          placeholder="JBSW Y3DP EHPK 3PXP …  /  otpauth://totp/…"
          aria-label={t("2FA secret")}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="shrink-0 rounded-lg border border-line px-2.5 text-[11px] text-fog/70 hover:bg-elevate"
          onClick={() => setShow((s) => !s)}
          aria-pressed={show}
        >
          {show ? t("Hide") : t("Show")}
        </button>
      </div>
      {parsed && !parsed.ok && (
        <p className="mt-1 text-[11px] text-danger" role="alert">
          {t(parsed.error)}
        </p>
      )}
      {parsed?.ok && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-fog/50">
          <span>{t("Code now:")}</span>
          <TotpCode secret={v} />
          {(parsed.spec.issuer || parsed.spec.account) && (
            <span className="truncate">{[parsed.spec.issuer, parsed.spec.account].filter(Boolean).join(" · ")}</span>
          )}
          <span>{t("Use {{otp}} in a task to type it.")}</span>
        </div>
      )}
    </div>
  );
}
