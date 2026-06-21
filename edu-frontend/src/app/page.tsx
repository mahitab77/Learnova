"use client";

/**
 * Home Page (LearnNova) — PLAYFUL PREMIUM (Client-aligned)
 * -----------------------------------------------------------------------------
 * ✅ Client-aligned “Explore” section:
 *    - 5 main categories:
 *      1) Curriculum (المناهج الدراسية)
 *      2) Quran & Islamic Studies (قرآن ومواد شرعية)
 *      3) Arabic for Non-Native Speakers (عربي لغير الناطقين)
 *      4) Arts & Skills (فنون ومهارات)
 *      5) Courses (كورسات)
 *
 * ✅ Sticky-notes redesign (per latest feedback):
 *    - Sticky notes are softer/lighter + shorter width
 *    - Notes are centered and equally distributed along the card height
 *    - Triangle tip attaches INTO the card
 *    - Card border/frame changes to the active sticky note color
 *    - Card width increased a bit, card height increased a bit
 *    - Curriculum accent switched to theme orange (matches the site feel)
 *
 * ✅ Keeps existing homepage structure and section IDs:
 *    - #how-it-works, #courses, #testimonials
 *
 * ✅ ESLint fixes:
 *    - FlowChips component moved OUTSIDE render (react-hooks/static-components)
 *
 * ✅ Next.js App Router fix:
 *    - useSearchParams() is now wrapped safely in Suspense
 */

import { Suspense, useMemo, useState } from "react";
import type { ReactNode } from "react";
import nextDynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import {
  Play,
  ArrowRight,
  BookOpen,
  GraduationCap,
  Users,
  Quote,
  Star,
  ChevronLeft,
  ChevronRight,
  Code2,
  Palette,
  Sparkles,
  ChevronDown,
} from "lucide-react";

/* =============================================================================
 * Dynamic import (typed) — ensures <SolarSystem lang={lang} /> is type-safe
 * ============================================================================= */
type Lang = "en" | "ar";
const SolarSystem = nextDynamic<{ lang: Lang }>(
  () => import("@/src/components/SolarSystem"),
  {
    ssr: false,
  }
);

interface CarouselItem {
  icon: ReactNode;
  title: string;
  description: string;
  color: string;
}

/* =============================================================================
 * Color helpers — for softer sticky notes + active card border
 * ============================================================================= */
function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.replace("#", "").trim();
  const full =
    cleaned.length === 3
      ? cleaned
          .split("")
          .map((c) => c + c)
          .join("")
      : cleaned;

  if (full.length !== 6) return null;

  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);

  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}

function rgba(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(0,0,0,${alpha})`;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/**
 * Mix a color with white to create a soft/pastel shade.
 * amount: 0 -> original, 1 -> white
 */
function mixWithWhite(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;

  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  const r = clamp(rgb.r + (255 - rgb.r) * amount);
  const g = clamp(rgb.g + (255 - rgb.g) * amount);
  const b = clamp(rgb.b + (255 - rgb.b) * amount);

  return `rgb(${r}, ${g}, ${b})`;
}

/* =============================================================================
 * Small Decorative Components
 * ============================================================================= */
function Flower({
  className = "",
  color = "#A2BF00",
}: {
  className?: string;
  color?: string;
}) {
  return (
    <div className={`pointer-events-none absolute ${className}`} aria-hidden>
      <div className="relative h-9 w-9">
        <span
          className="absolute inset-y-0 left-1/2 h-5 w-3 -translate-x-1/2 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span
          className="absolute inset-x-0 top-1/2 h-3 w-5 -translate-y-1/2 rounded-full"
          style={{ backgroundColor: color }}
        />
        <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
      </div>
    </div>
  );
}

/* =============================================================================
 * Playful-Premium Space Shapes (ring / sparkle / diamond)
 * - subtle, edges only, low opacity
 * ============================================================================= */
type SpaceVariant = "sparkle" | "diamond" | "ring";

function SpaceShape({
  variant,
  className = "",
  color = "#08ABD3",
  opacity = 0.14,
  strokeWidth = 7,
}: {
  variant: SpaceVariant;
  className?: string;
  color?: string;
  opacity?: number;
  strokeWidth?: number;
}) {
  const common = {
    className: `pointer-events-none absolute ${className}`,
    style: { opacity },
    "aria-hidden": true as const,
  };

  if (variant === "ring") {
    return (
      <div {...common}>
        <svg viewBox="0 0 100 100" className="h-full w-full">
          <circle
            cx="50"
            cy="50"
            r="34"
            fill="transparent"
            stroke={color}
            strokeWidth={strokeWidth}
          />
        </svg>
      </div>
    );
  }

  if (variant === "diamond") {
    return (
      <div {...common}>
        <svg viewBox="0 0 100 100" className="h-full w-full">
          <path d="M50 6 L94 50 L50 94 L6 50 Z" fill={color} />
        </svg>
      </div>
    );
  }

  return (
    <div {...common}>
      <svg viewBox="0 0 100 100" className="h-full w-full">
        <path
          d="M50 10 L58 42 L90 50 L58 58 L50 90 L42 58 L10 50 L42 42 Z"
          fill={color}
        />
      </svg>
    </div>
  );
}

/* =============================================================================
 * Mini flow chips (extracted component)
 * ============================================================================= */
function FlowChips({
  lang,
  isRTL,
  isCurriculum,
  accent,
}: {
  lang: Lang;
  isRTL: boolean;
  isCurriculum: boolean;
  accent: string;
}) {
  const chipBase =
    "inline-flex items-center gap-2 rounded-full bg-white/60 px-3 py-1 text-[11px] font-semibold text-[#111624]/80 ring-1 ring-black/5";

  if (isCurriculum) {
    return (
      <div
        className={`mt-4 flex flex-wrap gap-2 ${
          isRTL ? "justify-end" : "justify-start"
        }`}
      >
        <span className={chipBase}>
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: accent }}
          />
          {lang === "en" ? "Subject" : "المادة"}
        </span>
        <span className={chipBase}>
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: accent }}
          />
          {lang === "en" ? "Stage" : "المرحلة"}
        </span>
        <span className={chipBase}>
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: accent }}
          />
          {lang === "en" ? "Teachers" : "المدرسون"}
        </span>
      </div>
    );
  }

  return (
    <div
      className={`mt-4 flex flex-wrap gap-2 ${
        isRTL ? "justify-end" : "justify-start"
      }`}
    >
      <span className={chipBase}>
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: accent }}
        />
        {lang === "en" ? "Open to teachers directly" : "يفتح على المدرسين مباشرة"}
      </span>
      <span className={chipBase}>
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: accent }}
        />
        {lang === "en" ? "Video preview" : "فيديو تعريفي"}
      </span>
    </div>
  );
}

/* =============================================================================
 * Carousel — Why Choose LearnNova
 * ============================================================================= */
function Carousel({ lang, items }: { lang: Lang; items: CarouselItem[] }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const isRTL = lang === "ar";

  const nextSlide = () =>
    setCurrentIndex((prev) => (prev === items.length - 1 ? 0 : prev + 1));
  const prevSlide = () =>
    setCurrentIndex((prev) => (prev === 0 ? items.length - 1 : prev - 1));

  const PrevIcon = isRTL ? ChevronRight : ChevronLeft;
  const NextIcon = isRTL ? ChevronLeft : ChevronRight;

  return (
    <div className="relative">
      <div className="overflow-hidden rounded-2xl">
        <div dir="ltr">
          <div
            className="flex transition-transform duration-500 ease-in-out"
            style={{ transform: `translateX(-${currentIndex * 100}%)` }}
          >
            {items.map((item, index) => (
              <div key={index} className="w-full shrink-0">
                <div
                  dir={isRTL ? "rtl" : "ltr"}
                  className="flex flex-col items-center px-4 text-center"
                >
                  <div className="relative mb-8">
                    <div
                      className="
                        relative h-48 w-48 cursor-pointer rounded-full border-2
                        border-white/20 shadow-2xl transition-all duration-300
                        hover:translate-y-2 hover:scale-95
                      "
                      style={{
                        backgroundColor: item.color,
                        background: `linear-gradient(145deg, ${item.color}cc, ${item.color})`,
                        boxShadow: `
                          0 20px 40px rgba(0,0,0,0.1),
                          0 10px 20px rgba(0,0,0,0.05),
                          inset 0 -4px 8px rgba(0,0,0,0.1),
                          inset 0 4px 8px rgba(255,255,255,0.2)
                        `,
                      }}
                    >
                      <div className="absolute inset-4 rounded-full bg-white/10 blur-sm" />
                      <div className="relative z-10 flex h-full w-full items-center justify-center">
                        {item.icon}
                      </div>
                      <div
                        className="absolute inset-0 rounded-full opacity-20"
                        style={{
                          background:
                            "linear-gradient(145deg, transparent 30%, rgba(255,255,255,0.3) 100%)",
                        }}
                      />
                    </div>

                    <div
                      className={`
                        absolute -bottom-4 left-1/2 h-4 w-32 -translate-x-1/2
                        rounded-full blur-md transition-all duration-300
                        ${
                          currentIndex === index
                            ? "scale-110 opacity-50"
                            : "scale-100 opacity-30"
                        }
                      `}
                      style={{ backgroundColor: item.color }}
                    />
                  </div>

                  <h3 className="mb-4 text-2xl font-bold text-[#111624]">
                    {item.title}
                  </h3>
                  <p className="max-w-2xl text-lg leading-relaxed text-[#111624]/70">
                    {item.description}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <button
        onClick={prevSlide}
        className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-white/80 p-2 shadow-lg backdrop-blur-sm transition-all hover:bg-white ${
          isRTL ? "right-4" : "left-4"
        }`}
        aria-label="Previous"
      >
        <PrevIcon className="h-6 w-6 text-[#111624]" />
      </button>

      <button
        onClick={nextSlide}
        className={`absolute top-1/2 -translate-y-1/2 rounded-full bg-white/80 p-2 shadow-lg backdrop-blur-sm transition-all hover:bg-white ${
          isRTL ? "left-4" : "right-4"
        }`}
        aria-label="Next"
      >
        <NextIcon className="h-6 w-6 text-[#111624]" />
      </button>

      <div className="mt-12 flex justify-center gap-2">
        {items.map((_, index) => (
          <button
            key={index}
            onClick={() => setCurrentIndex(index)}
            className={`h-3 rounded-full transition-all ${
              index === currentIndex ? "w-8 bg-[#A2BF00]" : "w-3 bg-[#111624]/30"
            }`}
            aria-label={`Go to slide ${index + 1}`}
          />
        ))}
      </div>
    </div>
  );
}

/* =============================================================================
 * Sticky Notes — softer colors + shorter width + centered distribution
 * ============================================================================= */
type TrackKey =
  | "curriculum"
  | "quran"
  | "arabic_non_native"
  | "arts_skills"
  | "courses";

function StickyNotesRail({
  isRTL,
  activeKey,
  onSelect,
  tracks,
  heightPx,
}: {
  isRTL: boolean;
  activeKey: TrackKey;
  onSelect: (k: TrackKey) => void;
  tracks: Record<
    TrackKey,
    {
      icon: ReactNode;
      label: string;
      accent: string;
    }
  >;
  heightPx: number;
}) {
  const keys = Object.keys(tracks) as TrackKey[];

  return (
    <div
      className={`relative z-20 flex flex-col justify-evenly ${
        isRTL ? "items-end" : "items-start"
      } py-2`}
      style={{ height: heightPx }}
    >
      {keys.map((k) => {
        const tr = tracks[k];
        const isActive = k === activeKey;

        const bgA = mixWithWhite(tr.accent, 0.76);
        const bgB = mixWithWhite(tr.accent, 0.6);
        const tipA = mixWithWhite(tr.accent, 0.68);
        const tipB = mixWithWhite(tr.accent, 0.54);

        return (
          <button
            key={k}
            type="button"
            onClick={() => onSelect(k)}
            className={`
              group relative
              h-12 w-[190px] sm:w-[205px]
              rounded-2xl
              shadow-[0_14px_26px_rgba(0,0,0,0.10)]
              ring-1 ring-black/10
              transition-all
              ${
                isActive
                  ? "shadow-[0_18px_34px_rgba(0,0,0,0.14)]"
                  : "hover:shadow-[0_16px_30px_rgba(0,0,0,0.12)]"
              }
              ${isRTL ? "pl-8 pr-3 text-right" : "pl-3 pr-8 text-left"}
            `}
            style={{ background: `linear-gradient(135deg, ${bgA}, ${bgB})` }}
            aria-pressed={isActive}
          >
            <span
              aria-hidden
              className={`absolute top-0 h-full w-7 ${
                isRTL ? "-left-5" : "-right-5"
              }`}
              style={{
                background: `linear-gradient(135deg, ${tipA}, ${tipB})`,
                clipPath: isRTL
                  ? "polygon(100% 0%, 0% 50%, 100% 100%)"
                  : "polygon(0% 0%, 100% 50%, 0% 100%)",
                filter: "drop-shadow(0 10px 14px rgba(0,0,0,0.10))",
              }}
            />

            <div
              className={`relative flex h-full items-center gap-3 ${
                isRTL ? "flex-row-reverse" : ""
              }`}
            >
              <span
                className="
                  inline-flex h-9 w-9 items-center justify-center
                  rounded-full bg-white
                  ring-1 ring-black/10
                  shadow-[0_10px_18px_rgba(0,0,0,0.10)]
                  shrink-0
                "
                style={{ color: tr.accent }}
              >
                {tr.icon}
              </span>

              <div className="min-w-0">
                <div className="truncate text-[13px] font-extrabold leading-tight text-[#111624]">
                  {tr.label}
                </div>
                <div className="mt-1 h-1 w-14 rounded-full bg-black/10" />
              </div>
            </div>

            {isActive && (
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-2xl"
                style={{ boxShadow: `0 0 0 2px ${rgba(tr.accent, 0.22)}` }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function HomePageFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F18A68]">
      <p className="text-sm font-medium text-white/90">Loading homepage...</p>
    </div>
  );
}

/* =============================================================================
 * Home Page — Client-aligned Explore Tabs
 * ============================================================================= */
function HomeContent() {
  const searchParams = useSearchParams();

  const lang: Lang = searchParams.get("lang") === "ar" ? "ar" : "en";
  const isRTL = lang === "ar";
  const textAlign = isRTL ? "text-right" : "text-left";
  const withLangPath = (path: string) => (lang === "ar" ? `${path}?lang=ar` : path);

  const EXPLORE_CARD_HEIGHT = 460;
  const EXPLORE_CARD_WIDTH = "lg:w-[560px] xl:w-[610px]";

  const carouselItems: CarouselItem[] = [
    {
      icon: <BookOpen className="h-16 w-16 text-white" />,
      title: lang === "en" ? "Clear Learning Paths" : "مسارات واضحة",
      description:
        lang === "en"
          ? "Pick a subject or category, then quickly reach the right teachers for your child."
          : "اختر المادة أو القسم، ووصل بسرعة لأفضل المدرسين المناسبين لطفلك.",
      color: "#08ABD3",
    },
    {
      icon: <GraduationCap className="h-16 w-16 text-white" />,
      title: lang === "en" ? "Trusted Teachers" : "مدرسون موثوقون",
      description:
        lang === "en"
          ? "Watch teacher intro videos, read short profiles, and choose confidently."
          : "شاهد فيديو تعريفي لكل مدرس، واقرأ نبذة قصيرة، واختر بثقة.",
      color: "#A2BF00",
    },
    {
      icon: <Users className="h-16 w-16 text-white" />,
      title: lang === "en" ? "Made for Families" : "مناسب للعائلات",
      description:
        lang === "en"
          ? "A smooth experience for parents to find teachers across curricula, Quran, languages, and skills."
          : "تجربة سهلة لأولياء الأمور للعثور على مدرسين للمناهج والقرآن واللغات والمهارات.",
      color: "#FDCF2F",
    },
  ];

  const [activeTrack, setActiveTrack] = useState<TrackKey>("curriculum");

  const curriculumSubjects = useMemo(
    () => [
      { ar: "اللغة العربية", en: "Arabic" },
      { ar: "اللغة الإنجليزية", en: "English" },
      { ar: "الرياضيات", en: "Math" },
      { ar: "العلوم", en: "Science" },
      { ar: "اللغة الألمانية", en: "German" },
      { ar: "اللغة الفرنسية", en: "French" },
      { ar: "اللغة الإيطالية", en: "Italian" },
      { ar: "الدراسات", en: "Studies" },
      { ar: "الكمبيوتر", en: "Computer" },
      { ar: "ICT", en: "ICT" },
    ],
    []
  );

  const tracks = useMemo(() => {
    const t = {
      curriculum: {
        key: "curriculum" as const,
        icon: <BookOpen className="h-4 w-4" />,
        label: lang === "en" ? "Curriculum Subjects" : "مواد المناهج",
        headline: lang === "en" ? "Curriculum Subjects" : "المناهج الدراسية",
        description:
          lang === "en"
            ? "Choose a school subject, then select your child’s stage (Primary / Preparatory / Secondary) to see the teachers for that subject."
            : "اختر مادة دراسية، ثم حدّد المرحلة (ابتدائي / إعدادي / ثانوي) لعرض المدرسين المتخصصين في نفس المادة.",
        bullets:
          lang === "en"
            ? [
                "Subject → Stage → Teachers",
                "Teacher intro videos",
                "Short profiles for quick decisions",
              ]
            : [
                "مادة → مرحلة → مدرسين",
                "فيديو تعريفي للمدرس",
                "نبذة قصيرة لاتخاذ قرار سريع",
              ],
        accent: "#EB420E",
        href: `/curriculum?lang=${lang}`,
        badge: lang === "en" ? "Most requested" : "الأكثر طلباً",
      },

      quran: {
        key: "quran" as const,
        icon: <Sparkles className="h-4 w-4" />,
        label: lang === "en" ? "Quran" : "القرآن",
        headline:
          lang === "en" ? "Quran & Islamic Studies" : "القرآن والمواد الشرعية",
        description:
          lang === "en"
            ? "Open directly to Quran teachers. Watch intro videos and pick the best match."
            : "تفتح مباشرة على مدرسين القرآن. شاهد الفيديو التعريفي واختر الأنسب.",
        bullets:
          lang === "en"
            ? [
                "Direct teacher list (no extra steps)",
                "Tajweed & recitation options",
                "Intro video + short bio",
              ]
            : [
                "قائمة مدرسين مباشرة",
                "تجويد وتلاوة",
                "فيديو تعريفي + نبذة",
              ],
        accent: "#02ECD3",
        href: `/quran?lang=${lang}`,
        badge: lang === "en" ? "Direct" : "مباشر",
      },

      arabic_non_native: {
        key: "arabic_non_native" as const,
        icon: <Users className="h-4 w-4" />,
        label: lang === "en" ? "Arabic (Non-Native)" : "عربي لغير الناطقين",
        headline:
          lang === "en"
            ? "Arabic for Non-Native Speakers"
            : "لغة عربية لغير الناطقين",
        description:
          lang === "en"
            ? "For learners who don’t speak Arabic. Open directly to teachers specialized in Arabic as a language."
            : "لمن لا يتحدث العربية. تفتح مباشرة على المدرسين المتخصصين في تعليم العربية كلغة.",
        bullets:
          lang === "en"
            ? [
                "Speaking, listening, reading",
                "Levels for beginners → advanced",
                "Intro videos to choose faster",
              ]
            : [
                "محادثة واستماع وقراءة",
                "مستويات من مبتدئ لمتقدم",
                "فيديو تعريفي للاختيار بسهولة",
              ],
        accent: "#FDCF2F",
        href: `/arabic-non-native?lang=${lang}`,
        badge: lang === "en" ? "Popular" : "منتشر",
      },

      arts_skills: {
        key: "arts_skills" as const,
        icon: <Palette className="h-4 w-4" />,
        label: lang === "en" ? "Arts & Skills" : "فنون ومهارات",
        headline: lang === "en" ? "Arts & Skills" : "فنون ومهارات",
        description:
          lang === "en"
            ? "Creative and practical skills: drawing, music, handicrafts, and more."
            : "مهارات إبداعية وعملية: رسم، موسيقى، أعمال يدوية، وأكثر.",
        bullets:
          lang === "en"
            ? [
                "Drawing • Music • Handicrafts",
                "Tailoring & more",
                "Teacher video previews",
              ]
            : [
                "رسم • موسيقى • أعمال يدوية",
                "تفصيل وأكثر",
                "فيديوهات تعريفية للمدرسين",
              ],
        accent: "#08ABD3",
        href: `/arts-skills?lang=${lang}`,
        badge: lang === "en" ? "Skills" : "مهارات",
      },

      courses: {
        key: "courses" as const,
        icon: <Code2 className="h-4 w-4" />,
        label: lang === "en" ? "Courses" : "كورسات",
        headline: lang === "en" ? "Separate Courses" : "كورسات منفصلة",
        description:
          lang === "en"
            ? "Non-curriculum courses like German, Italian, French, English, and programming."
            : "كورسات خارج إطار المناهج مثل ألماني، إيطالي، فرنسي، إنجليزي، وبرمجة.",
        bullets:
          lang === "en"
            ? [
                "Language courses",
                "Programming courses",
                "Teacher videos & short summaries",
              ]
            : [
                "كورسات لغات",
                "كورسات برمجة",
                "فيديوهات تعريفية + نبذة قصيرة",
              ],
        accent: "#A2BF00",
        href: `/courses?lang=${lang}`,
        badge: lang === "en" ? "Separate" : "منفصل",
      },
    };

    return t;
  }, [lang]);

  const active = tracks[activeTrack];
  const frameOuterA = rgba(active.accent, 0.8);
  const frameOuterB = rgba(active.accent, 0.22);

  // Smooth scroll to planet section (id="courses")
  const scrollToPlanet = () => {
    const planetSection = document.getElementById("courses");
    if (planetSection) {
      planetSection.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  return (
    <div className="relative bg-[#F18A68]" dir={isRTL ? "rtl" : "ltr"}>
      <div className="relative min-h-screen">
        <Flower className="left-5 top-32 opacity-80" color="#A2BF00" />
        <Flower
          className="right-10 top-16 hidden opacity-70 md:block"
          color="#08ABD3"
        />
        <Flower
          className="right-[18%] top-[58%] hidden opacity-75 lg:block"
          color="#FDCF2F"
        />

        <main
          id="home"
          className="relative mx-auto flex max-w-6xl flex-col gap-8 px-4 sm:px-6 lg:flex-row lg:items-start lg:px-0 pt-8.75 lg:pt-10.75"
          style={{ minHeight: "calc(100vh - 80px)" }}
          suppressHydrationWarning
        >
          <section className="flex-1 rounded-3xl bg-white px-8 py-12 shadow-[0_30px_80px_rgba(0,0,0,0.08)]">
            <span className="inline-flex items-center gap-2 rounded-full bg-[#FDCF2F]/30 px-3 py-1 text-xs font-semibold text-[#111624]">
              <span className="inline-block h-2 w-2 rounded-full bg-[#A2BF00]" />
              {lang === "en" ? "Online learning platform" : "منصة تعليمية أونلاين"}
            </span>

            <h1
              className={`mt-6 text-balance text-[2.4rem] font-black leading-tight tracking-tight text-[#111624] sm:text-5xl lg:text-[3.35rem] ${textAlign}`}
            >
              {lang === "en" ? (
                <>
                  FIND THE RIGHT <br className="hidden sm:block" />
                  <span className="text-[#EB420E]">TEACHER</span> FOR{" "}
                  <br className="hidden sm:block" />
                  YOUR CHILD.
                </>
              ) : (
                <>
                  اختَر أفضل <br className="hidden sm:block" />
                  <span className="text-[#EB420E]">مدرس</span> لطفلك
                  <br className="hidden sm:block" />
                  بسهولة.
                </>
              )}
            </h1>

            <p className={`mt-6 max-w-lg text-lg leading-relaxed text-[#111624]/70 ${textAlign}`}>
              {lang === "en"
                ? "Curricula, Quran, Arabic for non-native speakers, arts & skills, and separate language/programming courses — all in one place with teacher intro videos."
                : "مناهج دراسية، قرآن ومواد شرعية، عربي لغير الناطقين، فنون ومهارات، وكورسات لغات/برمجة — كلها في مكان واحد مع فيديو تعريفي لكل مدرس."}
            </p>

            <div className={`mt-8 flex flex-wrap items-center gap-4 ${isRTL ? "justify-end" : ""}`}>
              <a
                href={withLangPath("/auth/register-parent")}
                className="inline-flex items-center gap-2 rounded-full bg-[#A2BF00] px-8 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#8fa800]"
              >
                {lang === "en" ? "Join Now" : "انضم الآن"}
                <ArrowRight className="h-4 w-4" />
              </a>

              <a
                href={withLangPath("/auth/register-student")}
                className="inline-flex items-center gap-2 rounded-full border border-[#F18A68]/30 bg-white px-6 py-3 text-sm font-semibold text-[#d95f38] shadow-sm transition-colors hover:bg-[#fff3ec]"
              >
                {lang === "en" ? "Student Sign Up" : "تسجيل الطالب"}
                <ArrowRight className="h-4 w-4" />
              </a>

              <button
                type="button"
                className="inline-flex items-center gap-2 text-sm font-semibold text-[#111624]"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#08ABD3] text-white">
                  <Play className="h-6 w-6" />
                </span>
                {lang === "en" ? "Watch intro" : "شاهد المقدمة"}
              </button>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-5">
              <div className="flex -space-x-3">
                <div className="h-10 w-10 rounded-full border-2 border-white bg-[url('https://images.pexels.com/photos/4145032/pexels-photo-4145032.jpeg?auto=compress&cs=tinysrgb&w=80')] bg-cover bg-center" />
                <div className="h-10 w-10 rounded-full border-2 border-white bg-[url('https://images.pexels.com/photos/3184398/pexels-photo-3184398.jpeg?auto=compress&cs=tinysrgb&w=80')] bg-cover bg-center" />
                <div className="h-10 w-10 rounded-full border-2 border-white bg-[url('https://images.pexels.com/photos/5905920/pexels-photo-5905920.jpeg?auto=compress&cs=tinysrgb&w=80')] bg-cover bg-center" />
                <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-white bg-[#FDCF2F] text-xs font-bold text-[#111624]">
                  +12k
                </div>
              </div>

              <div className={textAlign}>
                <p className="text-xs uppercase tracking-wide text-[#111624]/60">
                  {lang === "en" ? "Growing community" : "مجتمع متنامي"}
                </p>
                <p className="text-sm font-semibold text-[#111624]">
                  {lang === "en" ? (
                    <>
                      One platform, many <span className="text-[#A2BF00]">paths</span>
                    </>
                  ) : (
                    <>
                      منصة واحدة، <span className="text-[#A2BF00]">مسارات متعددة</span>
                    </>
                  )}
                </p>
              </div>
            </div>
          </section>

          <section className="relative flex-1 space-y-6 pt-4 pb-6">
            <div className="absolute -right-4 -top-4 h-20 w-20 rounded-full bg-[#FDCF2F]/20 blur-lg" />
            <div className="absolute bottom-10 left-0 h-16 w-16 rounded-full bg-[#08ABD3]/20 blur-md" />

            <div className="relative z-10 grid grid-cols-2 gap-6">
              <div className="relative flex aspect-square items-center justify-center">
                <div className="absolute inset-0 -rotate-6 scale-110 transform rounded-full bg-[#08ABD3]" />
                <div className="relative h-44 w-44 rotate-6 transform rounded-full border-4 border-white bg-[url('https://images.pexels.com/photos/8422248/pexels-photo-8422248.jpeg?auto=compress&cs=tinysrgb&w=200')] bg-cover bg-center shadow-2xl transition-transform duration-500 hover:rotate-12" />
                <div className="absolute -bottom-2 -right-2 h-24 w-24 rotate-45 rounded-2xl bg-[#FDCF2F] opacity-90 shadow-md" />
                <Flower className="right-4 top-4 opacity-90" color="#FDCF2F" />
              </div>

              <div className="relative aspect-square">
                <div className="absolute inset-0 rotate-3 scale-105 transform rounded-[35px_60px_45px_70px] bg-[#FDCF2F]" />
                <div className="absolute inset-2 rounded-[30px_55px_40px_65px] bg-white/10 backdrop-blur-sm" />
                <div className="absolute inset-4 rounded-[25px_50px_35px_60px] bg-[url('https://images.pexels.com/photos/4143799/pexels-photo-4143799.jpeg?auto=compress&cs=tinysrgb&w=300')] bg-cover bg-center shadow-xl" />
                <button className="absolute bottom-6 right-6 flex h-16 w-16 items-center justify-center rounded-full border-2 border-[#A2BF00]/20 bg-white/95 text-[#A2BF00] shadow-2xl transition-all duration-300 hover:scale-110 hover:shadow-3xl">
                  <Play className="h-7 w-7" />
                </button>
                <div className="absolute -left-3 -top-3 h-12 w-12 rounded-full bg-[#08ABD3] opacity-80" />
              </div>
            </div>

            <div className="relative z-10 mt-12 grid grid-cols-2 items-center gap-6 pt-4">
              <div className="relative w-full h-[calc(100%-5px)]">
                <div className="absolute inset-0 -rotate-3 scale-105 transform rounded-[60px_40px_80px_40px] bg-linear-to-br from-[#B19CD9] to-[#9B87C5] shadow-xl" />
                <div className="absolute top-3 left-3 right-3 bottom-3 rounded-[50px_30px_70px_30px] border-4 border-white/30 bg-[url('https://images.pexels.com/photos/3184611/pexels-photo-3184611.jpeg?auto=compress&cs=tinysrgb&w=300')] bg-cover bg-center" />
                <button className="absolute top-6 left-6 flex h-14 w-14 items-center justify-center rounded-full border-2 border-[#B19CD9]/30 bg-white/95 text-[#B19CD9] shadow-2xl transition-all duration-300 hover:scale-110">
                  <Play className="h-6 w-6" />
                </button>
                <div className="absolute -bottom-2 -right-2 h-8 w-20 rotate-45 rounded-full bg-[#FDCF2F] opacity-70" />
              </div>

              <div className="group relative aspect-square">
                <div className="absolute inset-0 -z-10 translate-x-2 translate-y-3 rounded-3xl bg-black/25 blur-md" />

                <div
                  className="
                    absolute inset-0
                    bg-linear-to-br from-[#A2BF00] via-[#95b200] to-[#8fa800]
                    shadow-xl transition-all duration-300
                    group-hover:-translate-y-1 group-hover:shadow-2xl
                  "
                  style={{
                    borderRadius: "24px calc(50% - 5px) calc(50% - 5px) 24px",
                  }}
                >
                  <div
                    className="absolute inset-5 md:inset-6 overflow-hidden bg-white/10 backdrop-blur-sm"
                    style={{
                      borderRadius: "16px calc(47% - 5px) calc(47% - 5px) 16px",
                    }}
                  >
                    <div className="h-full w-full bg-[url('https://images.pexels.com/photos/5211430/pexels-photo-5211430.jpeg?auto=compress&cs=tinysrgb&w=300')] bg-cover bg-center">
                      <div className="h-full w-full bg-black/20" />
                    </div>
                  </div>

                  <div className="absolute inset-y-0 left-6 flex flex-col justify-center text-white">
                    <div>
                      <div className="inline-block rounded-xl bg-white/22 px-3 py-1 text-xl font-black backdrop-blur-sm">
                        12k
                      </div>
                      <div className="mt-1 inline-block rounded-full bg-black/35 px-3 py-1 text-[10px] font-semibold">
                        {lang === "en" ? "Active" : "طلاب نشطون"}
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] text-white/85">
                      {lang === "en"
                        ? "families exploring teachers"
                        : "عائلات تبحث عن مدرسين"}
                    </p>
                  </div>
                </div>

                <div className="pointer-events-none">
                  <div className="absolute -right-2 -top-2 h-7 w-7 rotate-12 rounded-xl bg-[#FDCF2F] opacity-90 shadow-lg" />
                  <div className="absolute -bottom-3 left-4 h-6 w-6 -rotate-12 rounded-xl bg-[#08ABD3] opacity-80 shadow-lg" />
                  <div className="absolute top-0 left-10 h-3 w-12 rounded-full bg-white/45" />
                </div>
              </div>
            </div>

            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
              <div className="h-2 w-2 animate-pulse rounded-full bg-[#EB420E]" />
            </div>
          </section>

          {/* Animated Down Button - Bottom Center of Hero */}
          <button
            onClick={scrollToPlanet}
            className="absolute left-1/2 z-20 -translate-x-1/2 cursor-pointer transition-all duration-300 hover:-translate-y-1 focus:outline-none"
            style={{ bottom: "3.75rem" }}
            aria-label={lang === "en" ? "Scroll to planet section" : "انتقل إلى قسم الكوكب"}
            suppressHydrationWarning
          >
            <ChevronDown
              className="h-10 w-10 text-slate-100 drop-shadow-[0_10px_20px_rgba(0,0,0,0.25)]"
              strokeWidth={3}
            />
          </button>
        </main>
      </div>

      {/* PLANET SECTION - MOVED TO BE DIRECTLY UNDER HERO */}
      <section id="courses" className="relative overflow-hidden bg-white py-20">
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <div className="absolute -top-24 left-1/2 h-[520px] w-[920px] -translate-x-1/2 rounded-full bg-[#08ABD3]/10 blur-3xl" />
          <div className="absolute -bottom-28 right-[-120px] h-[520px] w-[520px] rounded-full bg-[#A2BF00]/10 blur-3xl" />
        </div>

        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <SpaceShape
            variant="ring"
            className="left-6 top-10 h-14 w-14 rotate-6"
            color="#08ABD3"
            opacity={0.14}
          />
          <SpaceShape
            variant="sparkle"
            className="left-[35%] top-8 h-7 w-7 -rotate-12"
            color="#FDCF2F"
            opacity={0.14}
          />
          <SpaceShape
            variant="diamond"
            className="right-10 top-12 h-10 w-10 rotate-12"
            color="#08ABD3"
            opacity={0.12}
          />
          <SpaceShape
            variant="sparkle"
            className="right-14 top-[38%] h-8 w-8 rotate-6"
            color="#A2BF00"
            opacity={0.12}
          />
          <SpaceShape
            variant="ring"
            className="right-10 top-[55%] h-12 w-12 -rotate-6"
            color="#FDCF2F"
            opacity={0.11}
          />
          <SpaceShape
            variant="diamond"
            className="left-[10%] bottom-10 h-10 w-10 -rotate-6"
            color="#FDCF2F"
            opacity={0.11}
          />
          <SpaceShape
            variant="sparkle"
            className="right-[22%] bottom-12 h-7 w-7 rotate-12"
            color="#08ABD3"
            opacity={0.12}
          />
        </div>

        <div className="relative mx-auto max-w-6xl px-4 sm:px-6 lg:px-0">
          <div className="text-center">
            <h2 className="text-3xl font-bold text-[#111624]">
              {lang === "en" ? "Explore Categories" : "استكشف الأقسام"}
            </h2>
            <p className="mx-auto mt-3 max-w-2xl text-base text-[#111624]/70">
              {lang === "en"
                ? "Choose what you need — curriculum, Quran, Arabic for non-native speakers, skills, or courses — then find teachers with intro videos."
                : "اختر ما تحتاجه — مناهج، قرآن، عربي لغير الناطقين، مهارات، أو كورسات — ثم اعثر على المدرسين مع فيديوهات تعريفية."}
            </p>

            <div className="mt-5 flex flex-wrap justify-center gap-3 text-xs">
              <span className="inline-flex items-center gap-2 rounded-full bg-[#08ABD3]/10 px-3 py-1 font-semibold text-[#111624]">
                <BookOpen className="h-4 w-4 text-[#08ABD3]" />
                {lang === "en" ? "Curriculum" : "مناهج"}
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-[#A2BF00]/10 px-3 py-1 font-semibold text-[#111624]">
                <Sparkles className="h-4 w-4 text-[#A2BF00]" />
                {lang === "en" ? "Quran" : "قرآن"}
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-[#FDCF2F]/20 px-3 py-1 font-semibold text-[#111624]">
                <Users className="h-4 w-4 text-[#111624]" />
                {lang === "en" ? "Teachers" : "مدرسون"}
              </span>
              <span className="inline-flex items-center gap-2 rounded-full bg-[#111624]/5 px-3 py-1 font-semibold text-[#111624]">
                <Play className="h-4 w-4 text-[#111624]" />
                {lang === "en" ? "Intro videos" : "فيديو تعريفي"}
              </span>
            </div>
          </div>

          <div className="mt-14 grid items-start gap-10 overflow-visible lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
            <div className="relative z-30 overflow-visible lg:-translate-x-4">
              <div className="relative rounded-3xl p-2 overflow-visible">
                <SolarSystem lang={lang} activeKey={activeTrack} onSelect={setActiveTrack} />
              </div>
            </div>

            <div className="relative z-10">
              <div className={`flex items-stretch ${isRTL ? "flex-row-reverse" : "flex-row"}`}>
                <div className={`${isRTL ? "-ml-7" : "-mr-7"} shrink-0`}>
                  <StickyNotesRail
                    isRTL={isRTL}
                    activeKey={activeTrack}
                    onSelect={setActiveTrack}
                    heightPx={EXPLORE_CARD_HEIGHT}
                    tracks={{
                      curriculum: {
                        icon: <BookOpen className="h-5 w-5" />,
                        label: tracks.curriculum.label,
                        accent: tracks.curriculum.accent,
                      },
                      quran: {
                        icon: <Sparkles className="h-5 w-5" />,
                        label: tracks.quran.label,
                        accent: tracks.quran.accent,
                      },
                      arabic_non_native: {
                        icon: <Users className="h-5 w-5" />,
                        label: tracks.arabic_non_native.label,
                        accent: tracks.arabic_non_native.accent,
                      },
                      arts_skills: {
                        icon: <Palette className="h-5 w-5" />,
                        label: tracks.arts_skills.label,
                        accent: tracks.arts_skills.accent,
                      },
                      courses: {
                        icon: <Code2 className="h-5 w-5" />,
                        label: tracks.courses.label,
                        accent: tracks.courses.accent,
                      },
                    }}
                  />
                </div>

                <div className={`min-w-0 flex-1 ${EXPLORE_CARD_WIDTH}`}>
                  <div className="relative">
                    <div
                      className="
                        relative overflow-hidden rounded-[40px]
                        shadow-[0_30px_70px_rgba(0,0,0,0.12)]
                      "
                      style={{
                        background: `linear-gradient(135deg, ${frameOuterA}, ${frameOuterB})`,
                      }}
                    >
                      <div className="m-2.5 rounded-4xl bg-white/70 backdrop-blur-md">
                        <div className="flex flex-col" style={{ height: EXPLORE_CARD_HEIGHT }}>
                          <div className="flex items-center justify-between gap-3 px-7 pt-6">
                            <span className="inline-flex items-center gap-2 rounded-full bg-black/5 px-3 py-1 text-xs font-semibold text-[#111624]">
                              <span
                                className="inline-block h-2 w-2 rounded-full"
                                style={{ backgroundColor: active.accent }}
                              />
                              {lang === "en" ? "Selected category" : "القسم المختار"}
                            </span>

                            <span className="inline-flex items-center gap-2 rounded-full bg-black/5 px-3 py-1 text-xs font-semibold text-[#111624]/75">
                              <Sparkles className="h-4 w-4" />
                              {active.badge}
                            </span>
                          </div>

                          <div
                            className="
                              flex-1 overflow-y-auto px-7 pb-7 pt-4
                              [&::-webkit-scrollbar]:hidden [-ms-overflow-style:'none'] [scrollbar-width:'none']
                            "
                          >
                            <h3 className="text-2xl font-black text-[#111624]">
                              {active.headline}
                            </h3>
                            <p className="mt-3 text-sm leading-relaxed text-[#111624]/75">
                              {active.description}
                            </p>

                            <FlowChips
                              lang={lang}
                              isRTL={isRTL}
                              isCurriculum={activeTrack === "curriculum"}
                              accent={active.accent}
                            />

                            <div className="mt-5 grid gap-2 sm:grid-cols-2">
                              {active.bullets.map((b) => (
                                <div
                                  key={b}
                                  className="flex items-start gap-2 rounded-2xl bg-white/60 p-3 ring-1 ring-black/5"
                                >
                                  <span
                                    className="mt-1 inline-block h-2 w-2 rounded-full"
                                    style={{ backgroundColor: active.accent }}
                                  />
                                  <span className="text-xs font-semibold text-[#111624]/80">
                                    {b}
                                  </span>
                                </div>
                              ))}
                            </div>

                            {activeTrack === "curriculum" && (
                              <div className="mt-6">
                                <p className="text-xs font-semibold text-[#111624]/70">
                                  {lang === "en" ? "Subjects preview" : "أمثلة على المواد"}
                                </p>

                                <div className="mt-3 flex flex-wrap gap-2">
                                  {curriculumSubjects.map((s) => (
                                    <span
                                      key={`${s.en}-${s.ar}`}
                                      className="
                                        inline-flex items-center gap-2 rounded-full
                                        bg-white/70 px-3 py-1 text-[11px]
                                        font-semibold text-[#111624]/85 ring-1 ring-black/5
                                      "
                                    >
                                      <span
                                        className="inline-block h-2 w-2 rounded-full"
                                        style={{ backgroundColor: active.accent }}
                                      />
                                      <span className="whitespace-nowrap">
                                        {s.ar} <span className="text-[#111624]/55">•</span> {s.en}
                                      </span>
                                    </span>
                                  ))}
                                </div>

                                <p className="mt-3 text-xs text-[#111624]/60">
                                  {lang === "en"
                                    ? "Inside the curriculum: Subject → Stage (Primary/Preparatory/Secondary) → Teachers."
                                    : "داخل المناهج: مادة → مرحلة (ابتدائي/إعدادي/ثانوي) → مدرسين."}
                                </p>
                              </div>
                            )}

                            <p className="mt-5 text-xs text-[#111624]/60">
                              {lang === "en"
                                ? "All teacher cards will include an intro video, teacher name, and a short profile summary."
                                : "كل مدرس سيظهر بفيديو تعريفي + الاسم + نبذة تعريفية قصيرة."}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="pointer-events-none" aria-hidden>
                      <SpaceShape
                        variant="ring"
                        className="-top-5 right-10 h-10 w-10 rotate-6"
                        color={active.accent}
                        opacity={0.16}
                      />
                      <SpaceShape
                        variant="sparkle"
                        className="-bottom-6 left-10 h-8 w-8 -rotate-12"
                        color="#FDCF2F"
                        opacity={0.14}
                      />
                      <SpaceShape
                        variant="diamond"
                        className="top-20 -right-6 h-8 w-8 rotate-12"
                        color="#A2BF00"
                        opacity={0.12}
                      />
                    </div>
                  </div>

                  <div className={`mt-8 flex ${isRTL ? "justify-end" : "justify-start"}`}>
                    <a
                      href={active.href}
                      className="inline-flex items-center gap-2 rounded-full px-7 py-3 text-sm font-semibold text-white shadow-sm transition-colors"
                      style={{ backgroundColor: active.accent }}
                    >
                      {lang === "en" ? "View details" : "عرض التفاصيل"}
                      <ArrowRight className="h-4 w-4" />
                    </a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-white py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-0">
          <div className={`mb-12 ${textAlign}`}>
            <h2 className="text-3xl font-bold text-[#111624]">
              {lang === "en" ? "Why Choose LearnNova?" : "لماذا تختار ليرن نوفا؟"}
            </h2>
            <p className="mt-4 text-lg text-[#111624]/70">
              {lang === "en"
                ? "Discover what makes our teacher discovery experience simple and effective"
                : "اكتشف ما يجعل تجربة اختيار المدرس سهلة وفعّالة"}
            </p>
          </div>

          <Carousel lang={lang} items={carouselItems} />
        </div>
      </section>

      <section id="how-it-works" className="bg-[#F8F9FA] py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-0">
          <div className={`mb-12 ${textAlign}`}>
            <h2 className="text-3xl font-bold text-[#111624]">
              {lang === "en" ? "How It Works" : "كيف تعمل المنصة"}
            </h2>
            <p className="mt-4 text-lg text-[#111624]/70">
              {lang === "en"
                ? "Simple steps to find the right teacher"
                : "خطوات بسيطة للعثور على المدرس المناسب"}
            </p>
          </div>

          <div className="relative">
            <div className="absolute left-1/2 top-0 bottom-0 hidden w-1 -translate-x-1/2 transform bg-[#A2BF00] md:block" />

            <div className="space-y-12 md:space-y-0">
              <div className="relative flex flex-col items-center md:flex-row">
                <div className="mb-6 flex-1 md:mb-0 md:pr-12 md:text-right">
                  <div className={`rounded-2xl bg-white p-6 shadow-sm ${textAlign}`}>
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-[#08ABD3]">
                      <div className="h-3 w-3 rounded-full bg-[#08ABD3]" />
                      {lang === "en" ? "Step 1" : "الخطوة الأولى"}
                    </span>
                    <h3 className="mt-2 text-xl font-bold text-[#111624]">
                      {lang === "en" ? "Create Account" : "إنشاء حساب"}
                    </h3>
                    <p className="mt-3 text-[#111624]/70">
                      {lang === "en"
                        ? "Sign up as a parent, add your basic details, and verify your contact info."
                        : "سجّل كولي أمر، أضف بياناتك الأساسية، ثم أكد بيانات التواصل."}
                    </p>
                  </div>
                </div>
                <div className="z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#08ABD3] text-lg font-bold text-white">
                  1
                </div>
                <div className="mt-6 flex-1 md:mt-0 md:pl-12 md:text-left" />
              </div>

              <div className="relative flex flex-col items-center md:flex-row">
                <div className="mb-6 flex-1 md:mb-0 md:pr-12 md:text-right" />
                <div className="z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#A2BF00] text-lg font-bold text-white">
                  2
                </div>
                <div className="mt-6 flex-1 md:mt-0 md:pl-12 md:text-left">
                  <div className={`rounded-2xl bg-white p-6 shadow-sm ${textAlign}`}>
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-[#A2BF00]">
                      <div className="h-3 w-3 rounded-full bg-[#A2BF00]" />
                      {lang === "en" ? "Step 2" : "الخطوة الثانية"}
                    </span>
                    <h3 className="mt-2 text-xl font-bold text-[#111624]">
                      {lang === "en"
                        ? "Choose Category & Level"
                        : "اختر القسم والمستوى"}
                    </h3>
                    <p className="mt-3 text-[#111624]/70">
                      {lang === "en"
                        ? "Pick curriculum, Quran, Arabic (non-native), skills, or courses — then filter by stage if needed."
                        : "اختر المناهج أو القرآن أو العربي لغير الناطقين أو المهارات أو الكورسات — ثم حدّد المرحلة إذا لزم."}
                    </p>
                  </div>
                </div>
              </div>

              <div className="relative flex flex-col items-center md:flex-row">
                <div className="mb-6 flex-1 md:mb-0 md:pr-12 md:text-right">
                  <div className={`rounded-2xl bg-white p-6 shadow-sm ${textAlign}`}>
                    <span className="inline-flex items-center gap-2 text-sm font-semibold text-[#FDCF2F]">
                      <div className="h-3 w-3 rounded-full bg-[#FDCF2F]" />
                      {lang === "en" ? "Step 3" : "الخطوة الثالثة"}
                    </span>
                    <h3 className="mt-2 text-xl font-bold text-[#111624]">
                      {lang === "en" ? "Watch & Decide" : "شاهد واختر"}
                    </h3>
                    <p className="mt-3 text-[#111624]/70">
                      {lang === "en"
                        ? "Watch teacher intro videos, read short bios, then choose the best match for your child."
                        : "شاهد الفيديو التعريفي للمدرس، واقرأ نبذة قصيرة، ثم اختر الأنسب لطفلك."}
                    </p>
                  </div>
                </div>
                <div className="z-10 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#FDCF2F] text-lg font-bold text-white">
                  3
                </div>
                <div className="mt-6 flex-1 md:mt-0 md:pl-12 md:text-left" />
              </div>
            </div>
          </div>

          <div className={`mt-12 flex ${isRTL ? "justify-end" : "justify-start"}`}>
            <a
              href={`/how-it-works?lang=${lang}`}
              className="inline-flex items-center gap-2 rounded-full bg-[#A2BF00] px-7 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#8fa800]"
            >
              {lang === "en" ? "View details" : "عرض التفاصيل"}
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </section>

      <section id="testimonials" className="bg-[#F18A68] py-16">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-0">
          <div className={`mb-12 ${textAlign}`}>
            <h2 className="text-3xl font-bold text-white">
              {lang === "en" ? "What Parents Say" : "ماذا يقول أولياء الأمور؟"}
            </h2>
            <p className="mt-4 text-lg text-white/90">
              {lang === "en"
                ? "Real feedback from families using LearnNova"
                : "آراء حقيقية من أولياء أمور جربوا ليرن نوفا مع أبنائهم"}
            </p>
          </div>

          <div className="grid gap-8 md:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-2xl bg-white/90 p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-2">
                <Quote className="h-5 w-5 text-[#A2BF00]" />
                <span className="text-sm font-semibold text-[#A2BF00]">
                  {lang === "en" ? "Parent of 10-year-old" : "ولية أمر (10 سنوات)"}
                </span>
              </div>
              <p className="text-sm leading-relaxed text-[#111624]/80">
                {lang === "en"
                  ? "I love that I can watch teacher intro videos and choose quickly."
                  : "أحببت أني أقدر أشوف فيديو تعريف لكل مدرس وأختار بسرعة."}
              </p>
              <div className="mt-4 flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star key={s} className="h-4 w-4 fill-[#FDCF2F] text-[#FDCF2F]" />
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-white/90 p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-2">
                <Quote className="h-5 w-5 text-[#08ABD3]" />
                <span className="text-sm font-semibold text-[#08ABD3]">
                  {lang === "en" ? "Parent of 14-year-old" : "ولي أمر (14 سنة)"}
                </span>
              </div>
              <p className="text-sm leading-relaxed text-[#111624]/80">
                {lang === "en"
                  ? "The curriculum flow is clear: subject, stage, then teachers."
                  : "المناهج واضحة: مادة، مرحلة، ثم المدرسين."}
              </p>
              <div className="mt-4 flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star key={s} className="h-4 w-4 fill-[#FDCF2F] text-[#FDCF2F]" />
                ))}
              </div>
            </div>

            <div className="rounded-2xl bg-white/90 p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-2">
                <Quote className="h-5 w-5 text-[#EB420E]" />
                <span className="text-sm font-semibold text-[#EB420E]">
                  {lang === "en" ? "Parent of 12-year-old" : "ولية أمر (12 سنة)"}
                </span>
              </div>
              <p className="text-sm leading-relaxed text-[#111624]/80">
                {lang === "en"
                  ? "Great teachers and simple browsing across different categories."
                  : "مدرسين ممتازين وتصفح سهل بين الأقسام المختلفة."}
              </p>
              <div className="mt-4 flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((s) => (
                  <Star key={s} className="h-4 w-4 fill-[#FDCF2F] text-[#FDCF2F]" />
                ))}
              </div>
            </div>
          </div>

          <div className={`mt-12 flex ${isRTL ? "justify-end" : "justify-start"}`}>
            <a
              href={`/testimonials?lang=${lang}`}
              className="inline-flex items-center gap-2 rounded-full bg-white/20 px-7 py-3 text-sm font-semibold text-white shadow-sm backdrop-blur transition-colors hover:bg-white/30"
            >
              {lang === "en" ? "View details" : "عرض التفاصيل"}
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </section>

      <section className="bg-white py-16">
        <div className="mx-auto max-w-4xl px-4 text-center sm:px-6 lg:px-0">
          <h2 className="text-3xl font-bold text-[#111624]">
            {lang === "en" ? "Ready to Start?" : "مستعد للبدء؟"}
          </h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-[#111624]/70">
            {lang === "en"
              ? "Join families discovering the best teachers through simple categories and intro videos."
              : "انضم لعائلات تختار أفضل المدرسين عبر أقسام واضحة وفيديوهات تعريفية."}
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-4">
            <a
              href={withLangPath("/auth/register-parent")}
              className="inline-flex items-center gap-2 rounded-full bg-[#A2BF00] px-8 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#8fa800]"
            >
              {lang === "en" ? "Register Your Child" : "سجل ابنك الآن"}
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href={withLangPath("/auth/register-student")}
              className="inline-flex items-center gap-2 rounded-full bg-[#F18A68] px-8 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#df7654]"
            >
              {lang === "en" ? "Register as Student" : "سجل كطالب"}
              <ArrowRight className="h-4 w-4" />
            </a>
            <a
              href={withLangPath("/auth/register-teacher")}
              className="inline-flex items-center gap-2 rounded-full bg-[#08ABD3] px-8 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#0799c0]"
            >
              {lang === "en" ? "Apply as Teacher" : "قدم كمعلم"}
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<HomePageFallback />}>
      <HomeContent />
    </Suspense>
  );
}
