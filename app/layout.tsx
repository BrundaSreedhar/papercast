import type { Metadata } from "next";
import { SiteHeader } from "./components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "PaperCast",
  description: "Turn an academic paper into a faithful podcast episode.",
};

/**
 * Applies the saved theme before the first paint.
 *
 * This has to be a blocking inline script rather than an effect. React runs
 * after the document has been painted, so reading the choice there means one
 * frame of the wrong palette — a white flash on every navigation for anyone
 * reading in the dark, which is exactly when it hurts most.
 */
const NO_FLASH = `
try {
  var t = localStorage.getItem("papercast-theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The script below sets data-theme before React hydrates, so the server
    // markup and the live DOM disagree on this element by design. Suppressing
    // applies one level deep — this element's own attributes — which is exactly
    // the scope of the mismatch and nothing more.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH }} />
      </head>
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
