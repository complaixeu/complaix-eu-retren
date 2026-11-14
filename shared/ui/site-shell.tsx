import Link from "next/link";
import type { ReactNode } from "react";
import { RetrenLogo } from "./retren-logo";
import styles from "./site-shell.module.css";

/** Shared public website frame for the landing page and every intake step. */
export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.site}>
      <SiteHeader />
      <div className={styles.content}>{children}</div>
      <SiteFooter />
    </div>
  );
}

function SiteHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/" className={styles.wordmark} aria-label="ReTren, inicio">
          <RetrenLogo />
          ReTren
        </Link>
        <nav className={styles.nav} aria-label="Navegación principal">
          <Link href="/#como-funciona" className={styles.navLink}>
            Cómo funciona
          </Link>
          <Link href="/reclamar/foto" className={styles.navCta}>
            Empezar reclamación
          </Link>
        </nav>
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <div className={styles.footerInner}>
        <div className={styles.footerBrand}>
          <Link href="/" className={styles.footerWordmark}>
            <RetrenLogo />
            ReTren
          </Link>
          <p>Prepara tu reclamación por el retraso del tren.</p>
        </div>
        <nav className={styles.footerNav} aria-label="Navegación del pie de página">
          <Link href="/">Inicio</Link>
          <Link href="/#como-funciona">Cómo funciona</Link>
          <Link href="/reclamar/foto">Iniciar reclamación</Link>
        </nav>
      </div>
      <div className={styles.footerBottom}>
        <div className={styles.footerBottomInner}>
          <span>© ReTren</span>
          <span>Gestión de reclamaciones ferroviarias</span>
        </div>
      </div>
    </footer>
  );
}
