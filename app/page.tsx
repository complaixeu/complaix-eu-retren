import { intakeStepHref } from "@/features/intake";
import { ButtonLink } from "@/shared/ui";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main id="contenido" tabIndex={-1} className={styles.page}>
      <section className={styles.intro} aria-labelledby="inicio-titulo">
        <h1 className={styles.brand}>ReTren</h1>
        <h2 id="inicio-titulo" className={styles.headline}>
          Reclama el retraso de tu tren
        </h2>
        <p className={styles.lead}>
          Sube la foto del billete y nosotros pedimos la compensación por ti.
        </p>
        <ButtonLink href={intakeStepHref("foto")} className={styles.cta}>
          Reclamar
        </ButtonLink>
      </section>
    </main>
  );
}
