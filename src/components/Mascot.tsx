// Clyde — the Clearcote chameleon (https://www.clearcotelabs.com/brand).
// Chameleons blend in to stay unseen — exactly the project's pitch ("blend in, stay clear").
// Pure SVG + CSS so it renders anywhere. The body subtly shifts hue (animate-blend) like
// it's blending, bobs on its branch (animate-bob), and blinks (animate-blink).
// Ported verbatim from the official site mascot for brand consistency.

export function Mascot({ className = "h-auto w-full", animate = true }: { className?: string; animate?: boolean }) {
  const fb = { transformBox: "fill-box", transformOrigin: "center" } as const;
  return (
    <svg
      viewBox="0 0 240 214"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Clyde, the Clearcote chameleon"
    >
      <defs>
        <linearGradient id="m-body" x1="60" y1="70" x2="200" y2="170" gradientUnits="userSpaceOnUse">
          <stop stopColor="#19c9bb" />
          <stop offset="0.55" stopColor="#46b6ff" />
          <stop offset="1" stopColor="#8b6dff" />
        </linearGradient>
        <linearGradient id="m-tail" x1="40" y1="110" x2="100" y2="170" gradientUnits="userSpaceOnUse">
          <stop stopColor="#8b6dff" />
          <stop offset="1" stopColor="#19c9bb" />
        </linearGradient>
      </defs>

      {/* branch */}
      <path d="M10 176 H230" stroke="#caa06a" strokeWidth="13" strokeLinecap="round" />
      <path d="M196 176 q14 -16 30 -12" stroke="#caa06a" strokeWidth="9" strokeLinecap="round" />
      <ellipse cx="34" cy="170" rx="13" ry="7" transform="rotate(-24 34 170)" fill="#54d39b" stroke="#0d0f14" strokeWidth="2.5" />
      <ellipse cx="58" cy="174" rx="11" ry="6" transform="rotate(-12 58 174)" fill="#7be0ad" stroke="#0d0f14" strokeWidth="2.5" />

      {/* the creature (blends hue) */}
      <g style={fb} className={animate ? "animate-blend" : undefined}>
        <g style={fb} className={animate ? "animate-bob" : undefined}>
          {/* curly tail */}
          <path
            d="M86 150 C 44 158 32 122 58 112 C 74 106 86 118 78 128 C 72 135 60 132 64 122"
            stroke="url(#m-tail)"
            strokeWidth="15"
            strokeLinecap="round"
            fill="none"
          />
          {/* back leg */}
          <path d="M96 150 v26 a9 9 0 0 0 18 0 v-20" fill="url(#m-body)" stroke="#0d0f14" strokeWidth="3" strokeLinejoin="round" />
          <path d="M99 178 l-7 6 M108 178 l7 6" stroke="#0d0f14" strokeWidth="3" strokeLinecap="round" />

          {/* body */}
          <ellipse cx="116" cy="120" rx="62" ry="46" fill="url(#m-body)" stroke="#0d0f14" strokeWidth="3.4" />
          {/* belly */}
          <ellipse cx="112" cy="138" rx="44" ry="24" fill="#ffffff" opacity="0.22" />
          {/* clear-coat sheen */}
          <path d="M80 96 q24 -22 64 -16" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="6" strokeLinecap="round" fill="none" />

          {/* front leg */}
          <path d="M150 152 v24 a9 9 0 0 0 18 0 v-18" fill="url(#m-body)" stroke="#0d0f14" strokeWidth="3" strokeLinejoin="round" />
          <path d="M153 178 l-7 6 M162 178 l7 6" stroke="#0d0f14" strokeWidth="3" strokeLinecap="round" />

          {/* dorsal crest */}
          <path d="M120 70 l9 -16 l9 16 z" fill="#8b6dff" stroke="#0d0f14" strokeWidth="2.5" strokeLinejoin="round" />
          <path d="M138 74 l8 -13 l8 13 z" fill="#54d39b" stroke="#0d0f14" strokeWidth="2.5" strokeLinejoin="round" />

          {/* head */}
          <circle cx="170" cy="104" r="34" fill="url(#m-body)" stroke="#0d0f14" strokeWidth="3.4" />
          {/* snout shading */}
          <path d="M188 118 q14 -4 16 -16" stroke="#0d0f14" strokeOpacity="0.25" strokeWidth="3" strokeLinecap="round" fill="none" />
          {/* nostril */}
          <circle cx="201" cy="100" r="2.4" fill="#0d0f14" />
          {/* smile */}
          <path d="M176 120 q14 10 28 -2" stroke="#0d0f14" strokeWidth="3" strokeLinecap="round" fill="none" />
          {/* cheek */}
          <circle cx="156" cy="118" r="6" fill="#ff9aa2" opacity="0.55" />

          {/* turret eye */}
          <circle cx="168" cy="98" r="19" fill="url(#m-body)" stroke="#0d0f14" strokeWidth="3.2" />
          <g style={fb} className={animate ? "animate-blink" : undefined}>
            <circle cx="168" cy="98" r="12" fill="#ffffff" stroke="#0d0f14" strokeWidth="2" />
            <circle cx="171" cy="98" r="5.5" fill="#0d0f14" />
            <circle cx="173" cy="95.5" r="1.8" fill="#ffffff" />
          </g>
        </g>
      </g>
    </svg>
  );
}
