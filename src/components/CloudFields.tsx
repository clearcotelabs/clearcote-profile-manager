"use client";

// The profile editor's Cloud section: where a cloud browser's traffic leaves, what it keeps, a cost
// cap, and a plain summary of what will happen, computed by the SAME plan the main process sends
// (electron/cloudbody.ts), so this never describes a different session from the one that starts.

import type { Profile } from "@/types/profile";
import type { CloudOptions } from "@/types/profile";
import { cloudExit, cloudIdentity, cloudSessionPlan } from "../../electron/cloudbody";
import { parseProxy } from "../../electron/proxyargs";
import { t, tx, tRich } from "@/lib/i18n";

/** Countries offered for the included residential IP. Any other 2-letter code can be typed in. */
export const CLOUD_COUNTRIES: [string, string][] = [
  ["us", tx("United States")],
  ["gb", tx("United Kingdom")],
  ["de", tx("Germany")],
  ["fr", tx("France")],
  ["nl", tx("Netherlands")],
  ["es", tx("Spain")],
  ["it", tx("Italy")],
  ["se", tx("Sweden")],
  ["pl", tx("Poland")],
  ["ca", tx("Canada")],
  ["au", tx("Australia")],
  ["br", tx("Brazil")],
  ["mx", tx("Mexico")],
  ["in", tx("India")],
  ["jp", tx("Japan")],
];

const field =
  "w-full rounded-lg border border-line bg-ink/70 px-3 py-2 text-sm text-fog placeholder-fog/30 outline-none focus:border-accent/60 focus:ring-1 focus:ring-accent/40";
const row = "flex items-start gap-2.5 rounded-lg px-1 py-1.5 text-sm text-fog/85";

export default function CloudFields({ profile, onChange }: { profile: Profile; onChange: (p: Profile) => void }) {
  const c: CloudOptions = profile.cloud ?? {};
  const set = <K extends keyof CloudOptions>(k: K, v: CloudOptions[K] | undefined) => {
    const next: CloudOptions = { ...c, [k]: v };
    for (const key of Object.keys(next) as (keyof CloudOptions)[]) if (next[key] === undefined) delete next[key];
    onChange({ ...profile, cloud: Object.keys(next).length ? next : undefined });
  };
  const exit = cloudExit(profile);
  const proxy = parseProxy(profile.proxy);
  const plan = cloudSessionPlan(profile);
  const countryName = CLOUD_COUNTRIES.find(([code]) => code === c.country)?.[1];

  return (
    <div className="space-y-4" data-cloud-fields>
      <fieldset className="rounded-lg border border-line p-3">
        <legend className="px-1 text-xs font-medium text-fog/60">{t("Where its traffic leaves")}</legend>
        <label className={row}>
          <input
            type="radio"
            name="cloud-exit"
            className="mt-1 accent-[#38e0d6]"
            checked={exit === "profile"}
            disabled={!proxy}
            onChange={() => set("exit", "profile")}
          />
          <span>
            {t("This profile's proxy")}
            <span className="block text-xs text-fog/45">
              {proxy
                ? t("{proxy} — http and socks5 work in the cloud.", { proxy: `${proxy.scheme}://${proxy.host}:${proxy.port}` })
                : t("This profile has no proxy.")}
            </span>
          </span>
        </label>
        <label className={row}>
          <input
            type="radio"
            name="cloud-exit"
            className="mt-1 accent-[#38e0d6]"
            checked={exit === "managed"}
            onChange={() => set("exit", "managed")}
          />
          <span className="min-w-0 flex-1">
            {t("The included residential IP")}
            <span className="block text-xs text-fog/45">{t("A home connection in the country you pick, included in the per-GB price.")}</span>
          </span>
        </label>
        {exit === "managed" && (
          <label className="mt-2 block pl-7 text-xs text-fog/60">
            {t("Country")}
            <span className="mt-1 flex items-center gap-2">
              <input
                aria-label={t("Cloud exit country")}
                list="cloud-countries"
                className={`${field} max-w-[110px] font-mono`}
                maxLength={2}
                placeholder={t("any")}
                value={c.country ?? ""}
                onChange={(e) => set("country", e.target.value.trim().toLowerCase() || undefined)}
              />
              <span className="text-fog/45">{countryName ? t(countryName) : c.country ? t("a 2-letter country code") : t("Any country")}</span>
            </span>
            <datalist id="cloud-countries">
              {CLOUD_COUNTRIES.map(([code, name]) => (
                <option key={code} value={code}>
                  {t(name)}
                </option>
              ))}
            </datalist>
          </label>
        )}
      </fieldset>

      <div className="space-y-1">
        <label className={row}>
          <input
            type="checkbox"
            className="mt-1 accent-[#38e0d6]"
            checked={c.keepCookies !== false}
            onChange={(e) => set("keepCookies", e.target.checked ? undefined : false)}
          />
          <span>
            {t("Keep its cookies between cloud sessions")}
            <span className="block text-xs text-fog/45">
              {t("Logins survive a stop. They are kept in your Clearcote account, separate from this PC's browser data.")}
            </span>
          </span>
        </label>
        <label className={row}>
          <input
            type="checkbox"
            className="mt-1 accent-[#38e0d6]"
            checked={!!c.adblock}
            onChange={(e) => set("adblock", e.target.checked || undefined)}
          />
          <span>
            {t("Block ads and trackers")}
            <span className="block text-xs text-fog/45">{t("Refused before they load, so their traffic is never billed. A few sites notice.")}</span>
          </span>
        </label>
        <label className={row}>
          <input
            type="checkbox"
            className="mt-1 accent-[#38e0d6]"
            checked={!!c.record}
            onChange={(e) => set("record", e.target.checked || undefined)}
          />
          <span>
            {t("Record a video of each session")}
            <span className="block text-xs text-fog/45">{t("Replay it from the dashboard afterwards.")}</span>
          </span>
        </label>
        <label className="block px-1 pt-1 text-xs text-fog/60">
          {t("Traffic cap (GB)")}
          <input
            aria-label={t("Cloud traffic cap in GB")}
            className={`${field} mt-1 max-w-[160px]`}
            type="number"
            min={0.001}
            step="any"
            placeholder={t("no cap")}
            value={c.maxGb ?? ""}
            onChange={(e) => set("maxGb", e.target.value === "" ? undefined : Number(e.target.value))}
          />
          <span className="mt-1 block text-fog/40">{t("The session stops when its traffic reaches this, so it can never cost more.")}</span>
        </label>
      </div>

      <div data-cloud-plan className="rounded-lg border border-line bg-ink/30 p-3 text-xs">
        {plan.ok ? (
          <ul className="space-y-1.5 text-fog/65">
            <li>
              {tRich("<b>Device:</b> the same one every session, from the seed {seed}.", {
                b: (s) => <span className="text-fog/90">{s}</span>,
                seed: <span className="font-mono text-fog/80">{cloudIdentity(profile)}</span>,
              })}
            </li>
            <li>
              {tRich("<b>Leaves through:</b> {where}", {
                b: (s) => <span className="text-fog/90">{s}</span>,
                where:
                  plan.exit.kind === "profile"
                    ? `${plan.exit.proxy}.`
                    : plan.exit.country
                      ? t("the included residential IP in {country}, the same one for up to a day.", { country: plan.exit.country.toUpperCase() })
                      : t("the included residential IP, any country, the same one for up to a day."),
              })}
            </li>
            <li>
              {tRich("<b>Cookies:</b> {what}", {
                b: (s) => <span className="text-fog/90">{s}</span>,
                what: plan.cookies
                  ? tRich("kept in the cloud profile {name}.", { name: <span className="font-mono text-fog/80">{plan.cookies}</span> })
                  : t("not kept; every session starts empty."),
              })}
            </li>
            {plan.localOnly.length > 0 && (
              <li data-cloud-local-only>
                {tRich("<b>Not used in the cloud:</b> {list}.", {
                  b: (s) => <span className="text-fog/90">{s}</span>,
                  list: plan.localOnly.join(", "),
                })}
              </li>
            )}
          </ul>
        ) : (
          <p role="alert" className="text-danger">
            {t(plan.error)}
          </p>
        )}
      </div>
    </div>
  );
}
