import type { Metadata } from "next";
import { preload } from "react-dom";
import { SiteShell } from "@/shared/ui/site-shell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ReTren", template: "%s · ReTren" },
  description: "Reclama la indemnización por el retraso de tu tren con la foto del billete.",
};

// The latin subsets of the two faces (DM Sans for text, Montserrat for headings) are needed on
// every page, so they start loading with the document. The rest of the subsets load on demand.
const FONT_OPTIONS = { as: "font", type: "font/woff2", crossOrigin: "anonymous" } as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  preload("/fonts/dm-sans-v17-latin.woff2", FONT_OPTIONS);
  preload("/fonts/montserrat-v31-latin.woff2", FONT_OPTIONS);

  return (
    <html lang="es" data-theme="light">
      <body>
        <a href="#contenido" className="skip-link">
          Saltar al contenido
        </a>
        <SiteShell>{children}</SiteShell>
      </body>
    </html>
  );
}
