import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "ReTren", template: "%s · ReTren" },
  description: "Reclama la indemnización por el retraso de tu tren con la foto del billete.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>
        <a href="#contenido" className="skip-link">
          Saltar al contenido
        </a>
        {children}
      </body>
    </html>
  );
}
