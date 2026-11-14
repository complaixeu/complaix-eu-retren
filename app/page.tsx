import { intakeStepHref } from "@/features/intake";
import { ButtonLink } from "@/shared/ui";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main id="contenido" tabIndex={-1} className={styles.page}>
      <section className={styles.hero} aria-labelledby="inicio-titulo">
        <div className={styles.intro}>
          <p className={styles.eyebrow}>Reclama tu viaje en tren</p>
          <h1 id="inicio-titulo" className={styles.headline}>
            Reclama el retraso de tu tren
          </h1>
          <p className={styles.lead}>
            Sube tu billete, comprueba los datos del viaje y prepara la reclamación paso a paso.
          </p>
          <ButtonLink href={intakeStepHref("foto")} className={styles.cta}>
            Empezar reclamación
          </ButtonLink>
        </div>
        <aside className={styles.overview} aria-label="Resumen del proceso">
          <h2 className={styles.overviewTitle}>Prepara antes de empezar</h2>
          <ol className={styles.overviewList}>
            <li className={styles.overviewItem}>
              <span className={styles.stepNumber}>01</span>
              <span className={styles.stepCopy}>
                <strong>Tu billete</strong>
                <span>Una foto legible o el PDF del viaje.</span>
              </span>
            </li>
            <li className={styles.overviewItem}>
              <span className={styles.stepNumber}>02</span>
              <span className={styles.stepCopy}>
                <strong>Tu documento</strong>
                <span>DNI, NIE o pasaporte.</span>
              </span>
            </li>
            <li className={styles.overviewItem}>
              <span className={styles.stepNumber}>03</span>
              <span className={styles.stepCopy}>
                <strong>Tu correo electrónico</strong>
                <span>Lo usaremos para identificar tu solicitud.</span>
              </span>
            </li>
          </ol>
        </aside>
      </section>
      <section id="como-funciona" className={styles.process} aria-labelledby="proceso-titulo">
        <h2 id="proceso-titulo" className={styles.processHeading}>
          Tú revisas cada paso antes de enviar
        </h2>
        <div className={styles.processGrid}>
          <article className={styles.processCard}>
            <span className={styles.stepNumber}>01</span>
            <h3>Billete</h3>
            <p>Sube una foto legible o el PDF que te envió la compañía.</p>
          </article>
          <article className={styles.processCard}>
            <span className={styles.stepNumber}>02</span>
            <h3>Datos del viaje</h3>
            <p>Revisa los datos detectados y completa lo que falte.</p>
          </article>
          <article className={styles.processCard}>
            <span className={styles.stepNumber}>03</span>
            <h3>Reclamación</h3>
            <p>Confirma la información y consulta el resultado de tu solicitud.</p>
          </article>
        </div>
      </section>
    </main>
  );
}
