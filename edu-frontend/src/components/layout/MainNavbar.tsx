// src/components/layout/MainNavbar.tsx
"use client";

/**
 * MainNavbar (LearnNova) — Auth-aware (SESSION-ONLY) — DROP-IN REPLACEMENT
 * -----------------------------------------------------------------------------
 * What this version fixes:
 * ✅ Uses your shared useSession() hook (cookie session auth)
 * ✅ Navbar updates immediately after login/logout (via auth:changed + useSession listener)
 * ✅ Replaces broken /dashboard /profile /settings links with role-based dashboard route
 * ✅ UserDropdown now receives required dashboardHref prop
 * ✅ "Register" stays inside Get Started dropdown (per your requirement)
 * ✅ Keeps UI/UX + RTL/LTR support as-is
 *
 * Notes:
 * - UserDropdown should only show Dashboard + Logout (profile/settings live inside dashboards)
 * - If user.role is missing for any reason, we safely fallback to "/"
 */

import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import LanguageSwitcher from "@/src/components/LanguageSwitcher";
import { UserDropdown } from "@/src/components/UserDropdown";
import { useSession } from "@/src/hooks/useSession";
import {
  ArrowRight,
  Users,
  UserCog,
  ChevronDown,
  BookOpen,
  BookText,
  Languages,
  Palette,
  GraduationCap,
} from "lucide-react";

type Lang = "en" | "ar";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function withLang(path: string, lang: Lang) {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}lang=${lang}`;
}

/**
 * Extract user fields safely without assuming the exact backend shape.
 * (Keeps strict TS happy even if SessionMe.user type evolves.)
 */
type AnyUser = {
  id?: number | null;
  role?: string | null;
  email?: string | null;
  full_name?: string | null;
  fullName?: string | null;
  name?: string | null;
  username?: string | null;
};

function getDashboardHrefByRole(roleRaw: string | null | undefined) {
  const role = (roleRaw || "").toLowerCase();
  if (role === "parent") return "/parent/dashboard";
  if (role === "student") return "/student/dashboard";
  if (role === "teacher") return "/teacher/dashboard";
  if (role === "admin") return "/admin/dashboard";
  if (role === "moderator") return "/moderator/dashboard";
  return "/";
}

/* -------------------------------------------------------------------------- */
/* Explore Dropdown (Client categories)                                       */
/* -------------------------------------------------------------------------- */

type ExploreItem = {
  key: "curriculum" | "quran" | "arabic" | "arts" | "courses";
  icon: ReactNode;
  titleEn: string;
  titleAr: string;
  descEn: string;
  descAr: string;
  href: string;
};

function ExploreDropdown({ lang, isHome }: { lang: Lang; isHome: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isRTL = lang === "ar";

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setIsOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const items: ExploreItem[] = useMemo(
    () => [
      {
        key: "curriculum",
        icon: <BookOpen className="h-5 w-5 text-[#08ABD3]" />,
        titleEn: "Curriculum",
        titleAr: "تعليم ومناهج دراسية",
        descEn: "School subjects by stage and teacher.",
        descAr: "مواد دراسية حسب المرحلة والمعلمين.",
        href: "/curriculum",
      },
      {
        key: "quran",
        icon: <BookText className="h-5 w-5 text-[#A2BF00]" />,
        titleEn: "Quran & Islamic Studies",
        titleAr: "قرآن ومواد شرعية",
        descEn: "Find Quran and Islamic teachers quickly.",
        descAr: "اختيار مدرسين قرآن ومواد شرعية بسهولة.",
        href: "/quran",
      },
      {
        key: "arabic",
        icon: <Languages className="h-5 w-5 text-[#FDCF2F]" />,
        titleEn: "Arabic for Non-Native Speakers",
        titleAr: "لغة عربية لغير الناطقين",
        descEn: "Arabic learning (not school curriculum).",
        descAr: "تعلم العربية (ليس مناهج مدرسية).",
        href: "/arabic",
      },
      {
        key: "arts",
        icon: <Palette className="h-5 w-5 text-[#EB420E]" />,
        titleEn: "Arts & Skills",
        titleAr: "فنون ومهارات",
        descEn: "Music, drawing, handmade, tailoring.",
        descAr: "ميوزيك، رسم، أعمال يدوية، تفصيل.",
        href: "/arts",
      },
      {
        key: "courses",
        icon: <GraduationCap className="h-5 w-5 text-[#B19CD9]" />,
        titleEn: "General Courses",
        titleAr: "كورسات عامة",
        descEn: "Languages & programming courses.",
        descAr: "كورسات لغات وبرمجة.",
        href: "/courses",
      },
    ],
    []
  );

  const linkBase = "text-[15px] text-white transition-colors hover:text-[#A2BF00]";

  return (
    <div className="relative z-50" ref={ref}>
      <button
        type="button"
        onClick={() => setIsOpen((p) => !p)}
        aria-expanded={isOpen}
        className={`group inline-flex items-center gap-2 ${linkBase}`}
      >
        {lang === "en" ? "Explore" : "استكشف"}
        <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : ""}`} />
      </button>

      <div
        className={`absolute top-full mt-3 w-[340px] rounded-2xl border border-gray-100 bg-white p-3 shadow-2xl transition-all duration-200 ${
          isOpen ? "visible scale-100 opacity-100" : "invisible scale-95 opacity-0"
        } ${isRTL ? "left-0" : "right-0"}`}
      >
        {isHome && (
          <div
            className={`mb-3 rounded-xl bg-[#F8F9FA] px-3 py-2 text-xs text-[#111624]/70 ${
              isRTL ? "text-right" : "text-left"
            }`}
          >
            {lang === "en" ? (
              <>
                Tip: You can also{" "}
                <a
                  href="#courses"
                  className="font-semibold text-[#08ABD3] hover:underline"
                  onClick={() => setIsOpen(false)}
                >
                  jump to the section
                </a>{" "}
                on this page.
              </>
            ) : (
              <>
                ملاحظة: يمكنك أيضًا{" "}
                <a
                  href="#courses"
                  className="font-semibold text-[#08ABD3] hover:underline"
                  onClick={() => setIsOpen(false)}
                >
                  الانتقال للقسم
                </a>{" "}
                في هذه الصفحة.
              </>
            )}
          </div>
        )}

        <div className="space-y-1">
          {items.map((it) => (
            <Link
              key={it.key}
              href={withLang(it.href, lang)}
              onClick={() => setIsOpen(false)}
              className={`group/item flex items-start gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-[#08ABD3]/10 ${
                isRTL ? "flex-row-reverse text-right" : "text-left"
              }`}
            >
              <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl bg-black/5">
                {it.icon}
              </div>

              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-[#111624]">
                  {lang === "en" ? it.titleEn : it.titleAr}
                </div>
                <div className="mt-1 text-xs text-[#111624]/60">
                  {lang === "en" ? it.descEn : it.descAr}
                </div>
              </div>

              <ArrowRight
                className={`mt-1 h-4 w-4 shrink-0 opacity-0 transition-opacity group-hover/item:opacity-100 ${
                  isRTL ? "rotate-180" : ""
                }`}
              />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Get Started Dropdown (Registration entry point)                            */
/* -------------------------------------------------------------------------- */

function GetStartedDropdown({ lang }: { lang: Lang }) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isRTL = lang === "ar";

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative z-50" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen((prev) => !prev)}
        className="group inline-flex items-center gap-2 rounded-full bg-[#A2BF00] px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-[#8fa800]"
      >
        {lang === "en" ? "Get Started" : "ابدأ الآن"}
        <ArrowRight
          className={`h-4 w-4 transition-transform ${
            isOpen ? (isRTL ? "-rotate-90" : "rotate-90") : ""
          }`}
        />
      </button>

      <div
        className={`absolute top-full mt-2 w-72 rounded-xl border border-gray-100 bg-white py-3 shadow-2xl transition-all duration-200 ${
          isOpen ? "visible scale-100 opacity-100" : "invisible scale-95 opacity-0"
        } ${isRTL ? "left-0" : "right-0"}`}
      >
        <Link
          href={withLang("/auth/register-parent", lang)}
          className={`group/item flex items-center gap-4 px-4 py-3 text-sm text-[#111624] transition-colors hover:bg-[#08ABD3]/10 ${
            isRTL ? "flex-row-reverse text-right" : ""
          }`}
          onClick={() => setIsOpen(false)}
        >
          <Users className="h-5 w-5 text-[#08ABD3]" />
          <div className="flex-1">
            <div className="font-semibold">{lang === "en" ? "Parent & Student" : "ولي أمر و طالب"}</div>
            <div className="mt-1 text-xs text-[#111624]/60">
              {lang === "en" ? "Register your child" : "سجّل ابنك في المنصة"}
            </div>
          </div>
          <ArrowRight className="h-4 w-4 opacity-0 transition-opacity group-hover/item:opacity-100" />
        </Link>

        <Link
          href={withLang("/auth/register-student", lang)}
          className={`group/item flex items-center gap-4 px-4 py-3 text-sm text-[#111624] transition-colors hover:bg-[#F18A68]/10 ${
            isRTL ? "flex-row-reverse text-right" : ""
          }`}
          onClick={() => setIsOpen(false)}
        >
          <GraduationCap className="h-5 w-5 text-[#F18A68]" />
          <div className="flex-1">
            <div className="font-semibold">{lang === "en" ? "Student" : "طالب"}</div>
            <div className="mt-1 text-xs text-[#111624]/60">
              {lang === "en" ? "Create your own account" : "أنشئ حسابك المباشر"}
            </div>
          </div>
          <ArrowRight className="h-4 w-4 opacity-0 transition-opacity group-hover/item:opacity-100" />
        </Link>

        <Link
          href={withLang("/auth/register-teacher", lang)}
          className={`group/item flex items-center gap-4 px-4 py-3 text-sm text-[#111624] transition-colors hover:bg-[#A2BF00]/10 ${
            isRTL ? "flex-row-reverse text-right" : ""
          }`}
          onClick={() => setIsOpen(false)}
        >
          <UserCog className="h-5 w-5 text-[#A2BF00]" />
          <div className="flex-1">
            <div className="font-semibold">{lang === "en" ? "Teacher" : "مدرس"}</div>
            <div className="mt-1 text-xs text-[#111624]/60">
              {lang === "en" ? "Apply to teach" : "قدّم للتدريس معنا"}
            </div>
          </div>
          <ArrowRight className="h-4 w-4 opacity-0 transition-opacity group-hover/item:opacity-100" />
        </Link>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Main Navbar                                                                */
/* -------------------------------------------------------------------------- */

const MainNavbar: FC = () => {
  const searchParams = useSearchParams();
  const pathname = usePathname();

  const lang: Lang = searchParams.get("lang") === "ar" ? "ar" : "en";
  const isRTL = lang === "ar";
  const textAlign = isRTL ? "text-right" : "text-left";

  const isHome = pathname === "/" || pathname === "";

  const nav = {
    home: isHome ? "#home" : withLang("/#home", lang),
    how: isHome ? "#how-it-works" : withLang("/how-it-works", lang),
    testimonials: isHome ? "#testimonials" : withLang("/testimonials", lang),
  };

  const linkBase = "text-[15px] text-white transition-colors hover:text-[#A2BF00]";
  const activeLink = "font-semibold text-[#A2BF00]";

  const activeKey =
    pathname === "/how-it-works" ? "how" : pathname === "/testimonials" ? "testimonials" : "home";

  // ✅ Session-aware UI (cookie-based)
  const { loading, authenticated, user, logout } = useSession();

  // ✅ Safe user extraction (avoid assumptions about backend shape)
  const u = (user ?? null) as AnyUser | null;

  const userName =
    u?.full_name ?? u?.fullName ?? u?.name ?? u?.username ?? (lang === "en" ? "User" : "مستخدم");

  const userEmail = u?.email ?? null;

  // If you later add avatar support to /auth/me, just map it here.
  const userAvatar: string | null = null;

  // ✅ Critical fix: dashboard route must be role-based (no /dashboard page)
  const dashboardHref = getDashboardHrefByRole(u?.role);

  return (
    <div className="bg-[#F18A68] overflow-visible" dir={isRTL ? "rtl" : "ltr"}>
      <header className="relative mx-auto flex h-28 max-w-6xl items-center justify-between overflow-visible px-4 sm:px-6 lg:px-0">
        {/* Logo + Brand */}
        <div className="relative flex items-center gap-4">
          <Link
            href={withLang("/", lang)}
            className="flex h-24 w-24 items-center justify-center rounded-full bg-linear-to-b from-white via-gray-50 to-gray-200 transition-shadow duration-300 -ml-6 -mt-6 -mb-6"
            style={{
              boxShadow: "0 0 0 1px #ffffff, 0 0 0 1px #d1d5db, 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 2px 4px rgba(255,255,255,0.9), inset 0 -8px 15px rgba(0,0,0,0.12), inset -3px -3px 8px rgba(0,0,0,0.08)"
            }}
            suppressHydrationWarning
            onMouseEnter={(e) => {
              e.currentTarget.style.boxShadow = "0 0 0 1px #ffffff, 0 0 0 1px #d1d5db, 0 0 30px rgba(255,255,255,0.8)";
              e.currentTarget.style.transform = "scale(0.97) translateY(2px)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.boxShadow = "0 0 0 1px #ffffff, 0 0 0 1px #d1d5db, 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 2px 4px rgba(255,255,255,0.9), inset 0 -8px 15px rgba(0,0,0,0.12), inset -3px -3px 8px rgba(0,0,0,0.08)";
              e.currentTarget.style.transform = "scale(1) translateY(0)";
            }}
            aria-label="LearnNova Home"
          >
            <Image
              src="/logo.png"
              alt="LearnNova"
              width={64}
              height={64}
              className="rounded-full object-cover"
              loading="eager"
            />
          </Link>

          {/* Brand text with adjusted spacing for logo */}
          <div className={`hidden md:block ${textAlign}`}>
            <p className="text-lg font-bold leading-tight text-white">LearnNova</p>
            <p className="text-sm leading-tight text-white/80">
              {lang === "en" ? "Smart EDU platform" : "منصة تعليمية ذكية"}
            </p>
          </div>

          <div className="flex items-center gap-2 md:hidden">
            <div className="h-10 w-10 rounded-full bg-[#A2BF00]" />
            <div className="h-10 w-10 -ml-4 rounded-full bg-[#08ABD3]" />
            <div className={textAlign}>
              <p className="text-sm font-semibold leading-tight text-white">LearnNova</p>
              <p className="text-[11px] leading-tight text-white/70">
                {lang === "en" ? "Smart EDU platform" : "منصة تعليمية ذكية"}
              </p>
            </div>
          </div>
        </div>

        {/* Desktop Navigation links */}
        <nav className="hidden items-center gap-7 md:flex">
          {/* Home */}
          {isHome ? (
            <a className={`${linkBase} ${activeKey === "home" ? activeLink : ""}`} href={nav.home}>
              {lang === "en" ? "Home" : "الرئيسية"}
            </a>
          ) : (
            <Link className={`${linkBase} ${activeKey === "home" ? activeLink : ""}`} href={nav.home}>
              {lang === "en" ? "Home" : "الرئيسية"}
            </Link>
          )}

          {/* Explore dropdown */}
          <ExploreDropdown lang={lang} isHome={isHome} />

          {/* How It Works */}
          {isHome ? (
            <a className={`${linkBase} ${activeKey === "how" ? activeLink : ""}`} href={nav.how}>
              {lang === "en" ? "How It Works" : "كيف تعمل"}
            </a>
          ) : (
            <Link className={`${linkBase} ${activeKey === "how" ? activeLink : ""}`} href={nav.how}>
              {lang === "en" ? "How It Works" : "كيف تعمل"}
            </Link>
          )}

          {/* Testimonials */}
          {isHome ? (
            <a
              className={`${linkBase} ${activeKey === "testimonials" ? activeLink : ""}`}
              href={nav.testimonials}
            >
              {lang === "en" ? "Testimonials" : "آراء العملاء"}
            </a>
          ) : (
            <Link
              className={`${linkBase} ${activeKey === "testimonials" ? activeLink : ""}`}
              href={nav.testimonials}
            >
              {lang === "en" ? "Testimonials" : "آراء العملاء"}
            </Link>
          )}
        </nav>

        {/* Actions */}
        <div className="flex items-center gap-4">
          <LanguageSwitcher />

          {/* Auth area (desktop) */}
          {!loading && (
            <>
              {/* Logged out → show Sign In only (Register is inside Get Started) */}
              {!authenticated && (
                <Link
                  href={withLang("/auth/login", lang)}
                  className="hidden rounded-full bg-white/30 px-5 py-2 text-sm font-medium text-white backdrop-blur transition-colors hover:bg-white/40 md:inline-flex"
                >
                  {lang === "en" ? "Sign in" : "تسجيل الدخول"}
                </Link>
              )}

              {/* Logged in → show User avatar dropdown */}
              {authenticated && u && (
                <UserDropdown
                  lang={lang}
                  userName={userName}
                  userEmail={userEmail}
                  userAvatar={userAvatar}
                  dashboardHref={dashboardHref}
                  logout={logout}
                />
              )}
            </>
          )}

          {/* Loading skeleton (desktop) */}
          {loading && (
            <div className="hidden h-10 w-10 animate-pulse rounded-full bg-white/20 md:block" />
          )}

          <GetStartedDropdown lang={lang} />
        </div>
      </header>

      {/* Mobile Navigation (simplified) */}
      <div className="flex items-center justify-between border-t border-white/20 px-4 py-3 md:hidden">
        <nav className="flex flex-1 items-center justify-around">
          {isHome ? (
            <a className={`${linkBase} ${activeKey === "home" ? activeLink : ""}`} href={nav.home}>
              {lang === "en" ? "Home" : "الرئيسية"}
            </a>
          ) : (
            <Link className={`${linkBase} ${activeKey === "home" ? activeLink : ""}`} href={nav.home}>
              {lang === "en" ? "Home" : "الرئيسية"}
            </Link>
          )}

          <ExploreDropdown lang={lang} isHome={isHome} />

          {isHome ? (
            <a className={`${linkBase} ${activeKey === "how" ? activeLink : ""}`} href={nav.how}>
              {lang === "en" ? "How" : "كيف"}
            </a>
          ) : (
            <Link className={`${linkBase} ${activeKey === "how" ? activeLink : ""}`} href={nav.how}>
              {lang === "en" ? "How" : "كيف"}
            </Link>
          )}
        </nav>

        {/* Mobile Auth Button (sign in only) */}
        <div className="ml-4">
          {!loading && !authenticated && (
            <Link
              href={withLang("/auth/login", lang)}
              className="rounded-full bg-white/30 px-4 py-2 text-xs font-medium text-white backdrop-blur"
            >
              {lang === "en" ? "Sign in" : "دخول"}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
};

export default MainNavbar;
