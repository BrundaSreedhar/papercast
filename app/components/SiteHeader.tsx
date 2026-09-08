"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "./ThemeToggle";

/** The five bars of the wordmark, also used to dress an empty shelf. */
export function Bars() {
  return (
    <span className="bars" aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

/**
 * One masthead on every page.
 *
 * Each page used to carry its own way back, which meant the library had none
 * once it had anything on it. Somewhere constant to click is the difference
 * between a set of pages and an application.
 */
export function SiteHeader() {
  const path = usePathname();
  const onLibrary = path.startsWith("/library");

  return (
    <header className="masthead">
      <div className="masthead-inner">
        <Link href="/" className="wordmark">
          <Bars />
          PaperCast
        </Link>
        <nav>
          <Link href="/" className={onLibrary ? undefined : "here"}>
            New episode
          </Link>
          <Link href="/library" className={onLibrary ? "here" : undefined}>
            Library
          </Link>
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
