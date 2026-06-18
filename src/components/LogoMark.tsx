// The Clearcote mark — https://www.clearcotelabs.com/brand
// A sticker-style gradient squircle (ink outline) holding one white shape that reads as
// both a "C" and a chameleon (eye top, body curving left, tail curling bottom-right).
// Reused verbatim from the official site logo so branding stays consistent.

const gid = "cc-logo-grad";

export function LogoMark({ className = "h-7 w-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 36 36" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="6" y1="5" x2="30" y2="31" gradientUnits="userSpaceOnUse">
          <stop stopColor="#19c9bb" />
          <stop offset="0.55" stopColor="#46b6ff" />
          <stop offset="1" stopColor="#8b6dff" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="30" height="30" rx="11" fill={`url(#${gid})`} stroke="#0d0f14" strokeWidth="2.4" />
      <path
        d="M25 12.5 A 8 8 0 1 0 25 23.5 c 5.2 0 6.2 -4.2 1.4 -5.2"
        stroke="#ffffff"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
      <circle cx="25" cy="12.5" r="3.6" fill="#ffffff" stroke="#0d0f14" strokeWidth="1.6" />
      <circle cx="26.1" cy="12.5" r="1.6" fill="#0d0f14" />
    </svg>
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 ${className}`}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight text-fog">
        Clear<span className="text-fog/60">cote</span>
      </span>
    </span>
  );
}
