/**
 * Landing-page background decor. Both are purely presentational and marked
 * aria-hidden — the translucent wave ribbon from the reference hero, and a
 * field of soft colour blobs that give the blue sections depth.
 */

export function WaveRibbon({ className = '' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1440 240"
      fill="none"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d="M0 130 C 220 220 420 220 650 92 C 850 -14 1090 2 1440 142 L1440 240 L0 240 Z"
        fill="url(#fluxa-ribbon-fill)"
        opacity="1"
      />
      <path
        d="M0 130 C 220 220 420 220 650 92 C 850 -14 1090 2 1440 142"
        stroke="url(#fluxa-ribbon-stroke)"
        strokeWidth="3"
      />
      <path
        d="M0 158 C 250 240 450 234 690 122 C 900 22 1110 42 1440 165"
        stroke="url(#fluxa-ribbon-stroke)"
        strokeWidth="1.5"
        opacity="0.4"
      />
      <defs>
        <linearGradient
          id="fluxa-ribbon-fill"
          x1="0"
          y1="0"
          x2="0"
          y2="240"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#ffffff" stopOpacity="0.82" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="1" />
        </linearGradient>
        <linearGradient
          id="fluxa-ribbon-stroke"
          x1="0"
          y1="0"
          x2="1440"
          y2="0"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}

export function GlowField({ className = '' }: { className?: string }) {
  return (
    <div
      className={`pointer-events-none absolute inset-0 overflow-hidden ${className}`}
      aria-hidden="true"
    >
      <div className="absolute -left-32 top-[-6rem] size-[34rem] rounded-full bg-iris-500/25 blur-3xl" />
      <div className="absolute -right-40 top-24 size-[40rem] rounded-full bg-brand-400/30 blur-3xl" />
      <div className="absolute bottom-[-10rem] left-1/3 size-[32rem] rounded-full bg-brand-600/20 blur-3xl" />
    </div>
  )
}
