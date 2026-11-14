import type { Metadata } from "next";
import type { ReactNode } from "react";
import styles from "./equipo/team.module.css";

export const metadata: Metadata = {
  title: "Equipo",
  // An internal tool: never indexed.
  robots: { index: false, follow: false },
};

/** Shell of the team view (/equipo): the skip link of the root layout lands on `#contenido`. */
export default function TeamLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <main id="contenido" tabIndex={-1} className={styles.main}>
        {children}
      </main>
    </div>
  );
}
