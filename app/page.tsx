import { intakeStepHref } from "@/features/intake";
import { ButtonLink } from "@/shared/ui";
import styles from "./page.module.css";

const howItWorks = [
  {
    title: "Sube la foto del billete",
    text: "Leemos los datos por ti. Tú solo compruebas que están bien.",
  },
  {
    title: "Responde unas pocas preguntas",
    text: "La hora real de llegada, tu documento y poco más.",
  },
  {
    title: "Reclamamos en tu nombre",
    text: "Escribimos a la compañía y te avisamos cuando haya un resultado.",
  },
];

export default function Home() {
  return (
    <main id="contenido" tabIndex={-1} className={styles.page}>
      <section className={styles.intro}>
        <h1 className={styles.brand}>ReTren</h1>
        <p className={styles.headline}>Reclama el retraso de tu tren sin escribir ni una carta</p>
        <p className={styles.lead}>
          Si tu tren llegó tarde, puede que te devuelvan parte del billete. Nos encargamos de
          pedirlo por ti.
        </p>
        <ButtonLink href={intakeStepHref("foto")} className={styles.cta}>
          Reclamar
        </ButtonLink>
      </section>

      <section className={styles.card} aria-labelledby="como-funciona">
        <h2 id="como-funciona" className={styles.cardTitle}>
          Cómo funciona
        </h2>
        <ol className={styles.line}>
          {howItWorks.map((step) => (
            <li key={step.title} className={styles.stop}>
              <span className={styles.dot} aria-hidden="true" />
              <p className={styles.stopTitle}>{step.title}</p>
              <p className={styles.stopText}>{step.text}</p>
            </li>
          ))}
        </ol>
        <p className={styles.note}>
          El dinero o el vale te llegan directamente a ti: ReTren nunca lo toca.
        </p>
      </section>
    </main>
  );
}
