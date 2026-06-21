// src/components/SolarSystem.tsx
"use client";

/**
 * SolarSystem (LearnNova) — Interactive Category Selector
 * -----------------------------------------------------------------------------
 * ✅ Client-aligned categories (matches Home page TrackKey):
 *    1) curriculum
 *    2) quran
 *    3) arabic_non_native
 *    4) arts_skills
 *    5) courses
 *
 * ✅ UX:
 *    - Click a planet to select a category (controlled via props)
 *    - Active planet has glow + pulse + higher z-index
 *    - Keyboard accessible (buttons + aria)
 *
 * ✅ Keeps:
 *    - Orbit labels behavior (orbit-1 label pushed outward)
 *    - Silver satellite decoration
 *    - isolate + z-index so labels float above adjacent UI
 *
 * ✅ ESLint fix:
 *    - Removed setState() call directly inside useEffect
 *    - Categories count is stable (5), so no "sync length" effect needed
 *
 * ✅ Animation:
 *    - deltaTime-based updates for smooth consistent motion
 */

import { useEffect, useMemo, useRef, useState } from "react";

type Lang = "en" | "ar";

/**
 * IMPORTANT:
 * These keys MUST match the TrackKey in src/app/page.tsx
 */
export type TrackKey =
  | "curriculum"
  | "quran"
  | "arabic_non_native"
  | "arts_skills"
  | "courses";

type CategoryPlanet = {
  key: TrackKey;
  name: string; // orbit label
  shortName: string; // tiny text on planet
  color: string;
  orbit: number;
  size: number;
  angle: number;
  hasMoon: boolean;
};

type Props = {
  lang: Lang;

  /**
   * Controlled active key (recommended):
   * Pass activeTrack from Home page so selection is in sync with the right panel.
   */
  activeKey?: TrackKey;

  /**
   * Called when a planet is clicked:
   * Use to setActiveTrack in Home page.
   */
  onSelect?: (key: TrackKey) => void;

  /**
   * Optional: allow disabling interactions (rare)
   */
  disabled?: boolean;
};

/* =============================================================================
 * Decorative: Silver Satellite (pure CSS)
 * ============================================================================= */
function SilverSatellite({ x, y }: { x: number; y: number }) {
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: `calc(50% + ${x}px)`,
        top: `calc(55% + ${y}px)`,
        transform: "translate(-50%, -50%)",
        zIndex: 6,
        filter: "drop-shadow(0 10px 18px rgba(0,0,0,0.12))",
        opacity: 0.9,
      }}
      aria-hidden
    >
      <div className="relative">
        {/* solar panels */}
        <div
          className="absolute left-[-18px] top-1/2 h-2 w-4 -translate-y-1/2 rounded-[3px]"
          style={{
            background: "linear-gradient(145deg, #F2F5F8, #B8C2CC)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6)",
            opacity: 0.85,
          }}
        />
        <div
          className="absolute right-[-18px] top-1/2 h-2 w-4 -translate-y-1/2 rounded-[3px]"
          style={{
            background: "linear-gradient(145deg, #F2F5F8, #B8C2CC)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.6)",
            opacity: 0.85,
          }}
        />

        {/* body */}
        <div
          className="h-3 w-3 rounded-sm"
          style={{
            background: "linear-gradient(145deg, #FFFFFF, #AEB7C0)",
            boxShadow: `
              0 6px 14px rgba(0,0,0,0.12),
              inset 0 -2px 4px rgba(0,0,0,0.10),
              inset 0 2px 4px rgba(255,255,255,0.55)
            `,
          }}
        />

        {/* antenna */}
        <div
          className="absolute left-1/2 top-2 h-2 w-0.5 -translate-x-1/2 rounded-full"
          style={{
            background: "linear-gradient(180deg, #E9EEF3, #97A3AF)",
            opacity: 0.9,
          }}
        />
        <div
          className="absolute left-1/2 top-3 h-1.5 w-1.5 -translate-x-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(255,255,255,0.9), rgba(180,194,204,0.35))",
            opacity: 0.9,
          }}
        />
      </div>
    </div>
  );
}

export default function SolarSystem({ lang, activeKey, onSelect, disabled }: Props) {
  /**
   * Orbit spacing:
   * - 5 orbits, tuned to fit nicely in 420px height
   */
  const ORBIT_STEP = 48;
  const ORBIT_PAD = 10;

  const categories = useMemo<CategoryPlanet[]>(
    () => [
      {
        key: "curriculum",
        name: lang === "en" ? "Curriculum" : "المناهج الدراسية",
        shortName: lang === "en" ? "Curric." : "مناهج",
        color: "#EB420E",
        orbit: 1,
        size: 42,
        angle: 20,
        hasMoon: false,
      },
      {
        key: "quran",
        name: lang === "en" ? "Quran & Islamic" : "القرآن والمواد الشرعية",
        shortName: lang === "en" ? "Quran" : "قرآن",
        color: "#02ECD3",
        orbit: 2,
        size: 46,
        angle: 100,
        hasMoon: true,
      },
      {
        key: "arabic_non_native",
        name: lang === "en" ? "Arabic (Non-Native)" : "عربي لغير الناطقين",
        shortName: lang === "en" ? "Arabic" : "عربي",
        color: "#FDCF2F",
        orbit: 3,
        size: 50,
        angle: 170,
        hasMoon: false,
      },
      {
        key: "arts_skills",
        name: lang === "en" ? "Arts & Skills" : "فنون ومهارات",
        shortName: lang === "en" ? "Arts" : "فنون",
        color: "#08ABD3",
        orbit: 4,
        size: 44,
        angle: 240,
        hasMoon: false,
      },
      {
        key: "courses",
        name: lang === "en" ? "Courses" : "كورسات",
        shortName: lang === "en" ? "Courses" : "كورسات",
        color: "#A2BF00",
        orbit: 5,
        size: 46,
        angle: 310,
        hasMoon: false,
      },
    ],
    [lang]
  );

  /**
   * If parent does NOT control activeKey, we still keep local selection.
   * (But in your Home page you WILL pass activeKey + onSelect.)
   */
  const [localSelected, setLocalSelected] = useState<TrackKey>("curriculum");
  const selected = activeKey ?? localSelected;

  /**
   * Planet angles are purely “animation state”.
   * Categories count is stable (5), so we do NOT need a "sync effect" here.
   */
  const [planetAngles, setPlanetAngles] = useState<number[]>(() =>
    categories.map((c) => c.angle)
  );

  // Satellite angle (outer orbit)
  const [satAngle, setSatAngle] = useState<number>(310);

  const animationRef = useRef<number | null>(null);
  const lastUpdateTimeRef = useRef<number | null>(null);

  const getOrbitRadius = (orbit: number) => orbit * ORBIT_STEP + ORBIT_PAD;

  const getPlanetPosition = (orbit: number, angle: number) => {
    const radius = getOrbitRadius(orbit);
    const rad = (angle * Math.PI) / 180;
    return { x: radius * Math.cos(rad), y: radius * Math.sin(rad) };
  };

  const getMoonPosition = (planetX: number, planetY: number, angle: number) => {
    const moonRadius = 25;
    const moonAngle = angle * 3;
    const rad = (moonAngle * Math.PI) / 180;
    return {
      x: planetX + moonRadius * Math.cos(rad),
      y: planetY + moonRadius * Math.sin(rad),
    };
  };

  /**
   * Animation loop (deltaTime-based)
   */
  useEffect(() => {
    const animate = (timestamp: number) => {
      if (lastUpdateTimeRef.current === null) lastUpdateTimeRef.current = timestamp;
      const deltaTime = timestamp - lastUpdateTimeRef.current;

      if (deltaTime >= 16) {
        setPlanetAngles((prev) =>
          prev.map((angle, index) => {
            const orbit = categories[index]?.orbit ?? 1;
            const speed = 0.0018 * (0.85 + orbit * 0.18); // deg per ms
            return (angle + speed * deltaTime) % 360;
          })
        );

        setSatAngle((prev) => (prev + 0.0016 * deltaTime) % 360);
        lastUpdateTimeRef.current = timestamp;
      }

      animationRef.current = window.requestAnimationFrame(animate);
    };

    animationRef.current = window.requestAnimationFrame(animate);

    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      lastUpdateTimeRef.current = null;
    };
  }, [categories]);

  /**
   * Selection handler:
   * - updates local fallback
   * - notifies parent (Home page) if provided
   */
  const handleSelect = (key: TrackKey) => {
    if (disabled) return;
    setLocalSelected(key);
    onSelect?.(key);
  };

  // Satellite orbit (outer) — just beyond orbit 5
  const satelliteOrbit = 5.35;
  const satPos = getPlanetPosition(satelliteOrbit, satAngle);

  return (
    // isolate + z so overflow labels stay above sibling column (homepage layout)
    <div className="relative isolate z-30 flex h-[420px] w-full items-center justify-center">
      {/* Sun (Student) */}
      <div className="absolute left-1/2 top-[55%] z-20 h-20 w-20 -translate-x-1/2 -translate-y-1/2">
        <div
          className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-full shadow-2xl"
          style={{
            background: "linear-gradient(145deg, #FFD700, #FF6B00)",
            boxShadow: `
              0 0 40px rgba(255, 215, 0, 0.6),
              inset 0 -6px 12px rgba(0,0,0,0.2),
              inset 0 6px 12px rgba(255,255,255,0.3)
            `,
          }}
        >
          <span className="z-10 px-2 text-center text-xs font-bold text-white">
            {lang === "en" ? "Student" : "الطالب"}
          </span>
          <div className="absolute inset-0 animate-ping rounded-full bg-[#FFD700] opacity-20" />
        </div>
      </div>

      {/* Orbits */}
      {categories.map((cat) => {
        const r = getOrbitRadius(cat.orbit);
        return (
          <div
            key={`orbit-${cat.orbit}-${cat.key}`}
            className="absolute rounded-full border border-[#111624]/10"
            style={{
              width: `${r * 2}px`,
              height: `${r * 2}px`,
              left: `calc(50% - ${r}px)`,
              top: `calc(55% - ${r}px)`,
            }}
          />
        );
      })}

      {/* Satellite orbit (dashed) */}
      <div
        className="pointer-events-none absolute rounded-full border border-[#111624]/10"
        style={{
          width: `${getOrbitRadius(satelliteOrbit) * 2}px`,
          height: `${getOrbitRadius(satelliteOrbit) * 2}px`,
          left: `calc(50% - ${getOrbitRadius(satelliteOrbit)}px)`,
          top: `calc(55% - ${getOrbitRadius(satelliteOrbit)}px)`,
          borderStyle: "dashed",
          opacity: 0.55,
        }}
      />

      <SilverSatellite x={satPos.x} y={satPos.y} />

      {/* Planets (interactive buttons) */}
      {categories.map((cat, index) => {
        const angle = planetAngles[index] ?? cat.angle; // defensive
        const pos = getPlanetPosition(cat.orbit, angle);
        const isActive = selected === cat.key;

        const moonPos = cat.hasMoon ? getMoonPosition(pos.x, pos.y, angle) : null;

        return (
          <div key={cat.key} className="absolute" style={{ zIndex: isActive ? 40 : 10 }}>
            <button
              type="button"
              onClick={() => handleSelect(cat.key)}
              disabled={disabled}
              className={`
                absolute flex items-center justify-center rounded-full shadow-lg
                transition-all duration-300
                hover:scale-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#111624]/30
                ${disabled ? "cursor-not-allowed opacity-80" : "cursor-pointer"}
              `}
              style={{
                width: `${cat.size}px`,
                height: `${cat.size}px`,
                background: `linear-gradient(145deg, ${cat.color}cc, ${cat.color})`,
                left: `calc(50% + ${pos.x}px - ${cat.size / 2}px)`,
                top: `calc(55% + ${pos.y}px - ${cat.size / 2}px)`,

                // Active glow makes the selection feel “alive”
                boxShadow: isActive
                  ? `
                    0 10px 26px rgba(0,0,0,0.18),
                    0 0 0 6px rgba(255,255,255,0.55),
                    0 0 28px ${cat.color}66,
                    inset 0 -3px 6px rgba(0,0,0,0.12),
                    inset 0 3px 6px rgba(255,255,255,0.22)
                  `
                  : `
                    0 6px 20px rgba(0,0,0,0.15),
                    inset 0 -3px 6px rgba(0,0,0,0.10),
                    inset 0 3px 6px rgba(255,255,255,0.20)
                  `,
                transform: isActive ? "scale(1.08)" : undefined,
              }}
              aria-pressed={isActive}
              aria-label={cat.name}
              title={cat.name}
            >
              {/* Active pulse ring */}
              {isActive && (
                <span
                  className="pointer-events-none absolute -inset-2.5 animate-pulse rounded-full"
                  style={{ boxShadow: `0 0 0 10px ${cat.color}20` }}
                  aria-hidden
                />
              )}

              <span className="px-1 text-center text-[9px] font-bold leading-tight text-white">
                {cat.shortName}
              </span>
            </button>

            {/* Optional moon (kept for a playful accent on Quran) */}
            {cat.hasMoon && moonPos && (
              <button
                type="button"
                onClick={() => handleSelect(cat.key)}
                disabled={disabled}
                className={`absolute flex h-4 w-4 items-center justify-center rounded-full shadow-lg transition-transform ${
                  disabled ? "cursor-not-allowed" : "cursor-pointer hover:scale-110"
                }`}
                style={{
                  background: "linear-gradient(145deg, #E8F4F8, #B8E6F8)",
                  boxShadow: `
                    0 0 8px rgba(232, 244, 248, 0.8),
                    inset 0 -1px 2px rgba(0,0,0,0.1),
                    inset 0 1px 2px rgba(255,255,255,0.4)
                  `,
                  left: `calc(50% + ${moonPos.x}px - 8px)`,
                  top: `calc(55% + ${moonPos.y}px - 8px)`,
                  zIndex: isActive ? 41 : 11,
                }}
                aria-label={lang === "en" ? "Select category" : "اختر القسم"}
                title={lang === "en" ? "Select" : "اختر"}
              />
            )}
          </div>
        );
      })}

      {/* Orbit labels */}
      <div className="pointer-events-none absolute left-1/2 top-[55%] z-50 -translate-x-1/2 -translate-y-1/2">
        {categories.map((cat, index) => {
          const angle = planetAngles[index] ?? cat.angle;
          const p = getPlanetPosition(cat.orbit, angle);
          const isActive = selected === cat.key;

          // Label offsets
          const OUTER_OFFSET = cat.size / 2 + 34;
          const ABOVE_OFFSET = cat.size / 2 + 34;

          /**
           * Orbit 1 label:
           * - Always on the OUTER side away from the sun (prevents overlap)
           * Others:
           * - “above” the planet
           */
          let lx = p.x;
          let ly = p.y - ABOVE_OFFSET;

          if (cat.orbit === 1) {
            const len = Math.max(1, Math.sqrt(p.x * p.x + p.y * p.y));
            const ux = p.x / len;
            const uy = p.y / len;
            lx = p.x + ux * OUTER_OFFSET;
            ly = p.y + uy * OUTER_OFFSET;
          }

          return (
            <div
              key={`label-${cat.key}`}
              className={`
                absolute whitespace-nowrap rounded-full px-2 py-0.5
                text-[11px] font-semibold leading-none backdrop-blur-sm
                border shadow-sm
                ${
                  isActive
                    ? "bg-white/95 text-[#111624] border-black/10"
                    : "bg-orange-100/90 text-[#5a2f00] border-orange-200/70"
                }
              `}
              style={{
                left: `${lx}px`,
                top: `${ly}px`,
                transform: "translate(-50%, -50%)",
                boxShadow: isActive ? `0 10px 22px rgba(0,0,0,0.10)` : undefined,
              }}
            >
              {cat.name}
            </div>
          );
        })}
      </div>
    </div>
  );
}
