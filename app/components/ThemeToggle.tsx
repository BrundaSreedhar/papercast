"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const ORDER: Theme[] = ["system", "light", "dark"];
const ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };
const LABEL: Record<Theme, string> = {
  system: "Theme: following your system",
  light: "Theme: light",
  dark: "Theme: dark",
};

/**
 * Light, dark, or whatever the system says.
 *
 * Three states rather than two, because "dark mode off" and "follow my
 * machine" are different wishes and a two-way switch quietly overrides the
 * second. The choice is written to the document element, which is also where
 * the inline script in the layout puts it before first paint — without that the
 * page renders in the wrong palette for a frame and flashes.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  // Read on mount rather than during render: the server has no localStorage,
  // and guessing would mean the markup disagreeing with the DOM on hydration.
  useEffect(() => {
    const stored = window.localStorage.getItem("papercast-theme");
    if (stored === "light" || stored === "dark" || stored === "system") setTheme(stored);
  }, []);

  function choose(next: Theme) {
    setTheme(next);
    try {
      window.localStorage.setItem("papercast-theme", next);
    } catch {
      // A browser refusing storage still gets the theme for this page.
    }
    const root = document.documentElement;
    if (next === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => choose(ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!)}
      title={LABEL[theme]}
      aria-label={LABEL[theme]}
    >
      <span aria-hidden="true">{ICON[theme]}</span>
    </button>
  );
}
