import { ActionSubmit } from "./action-submit";
import { advanceClock, resetClock } from "../actions";
import styles from "../team.module.css";

export function ClockPanel({ now, back, caseId }: { now: string; back: string; caseId: string }) {
  const shown = new Date(now).toLocaleString("en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Madrid",
  });
  return (
    <section aria-labelledby="clock" className={styles.card}>
      <h2 id="clock" className={styles.subtitle}>
        Simulated clock
      </h2>
      <p>
        Current simulated time: <strong>{shown}</strong>
      </p>
      <p className={styles.muted}>Moves time forward for this case only and runs the scheduler.</p>
      <div className={styles.quickDays}>
        {[3, 12, 30, 45].map((days) => (
          <form action={advanceClock} key={days}>
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="caseId" value={caseId} />
            <input type="hidden" name="days" value={days} />
            <ActionSubmit pendingLabel="Moving clock…">+{days} days</ActionSubmit>
          </form>
        ))}
      </div>
      <form action={advanceClock} className={styles.inline}>
        <input type="hidden" name="back" value={back} />
        <input type="hidden" name="caseId" value={caseId} />
        <label className={styles.label}>
          Custom days
          <input
            name="days"
            type="number"
            min={1}
            max={400}
            step={1}
            defaultValue={1}
            required
            className={styles.select}
          />
        </label>
        <ActionSubmit pendingLabel="Moving clock…">Move clock forward</ActionSubmit>
      </form>
      <form action={resetClock}>
        <input type="hidden" name="back" value={back} />
        <ActionSubmit pendingLabel="Resetting…" variant="quiet">
          Reset simulated clock
        </ActionSubmit>
      </form>
    </section>
  );
}
