import { Button } from "@/shared/ui";
import { advanceClock, resetClock } from "../actions";
import styles from "../team.module.css";

/** The demo clock: moves "now" forward for the tick (the real clock is never touched). */
export function ClockPanel({ now, back, caseId }: { now: string; back: string; caseId: string }) {
  const shown = new Date(now).toLocaleString("es-ES", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Madrid",
  });
  return (
    <section aria-labelledby="reloj" className={styles.card}>
      <h2 id="reloj" className={styles.subtitle}>
        Reloj de demostración
      </h2>
      <p>
        Fecha del reloj: <strong>{shown}</strong>
      </p>
      <p className={styles.muted}>
        Al adelantarlo se ejecuta el ciclo de plazos (recordatorios, escalada) y se envía lo
        pendiente de este caso, igual que cada hora en el sistema real. Los demás casos no se tocan.
      </p>
      <form action={advanceClock} className={styles.inline}>
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="caseId" value={caseId} />
        <label className={styles.label}>
          Días a adelantar
          <input
            name="days"
            type="number"
            min={1}
            max={400}
            step={1}
            defaultValue={30}
            required
            className={styles.select}
          />
        </label>
        <Button type="submit">Adelantar el reloj</Button>
      </form>
      <form action={resetClock}>
        <input type="hidden" name="back" value={back} />
        <Button type="submit" variant="quiet">
          Reiniciar el reloj
        </Button>
      </form>
    </section>
  );
}
