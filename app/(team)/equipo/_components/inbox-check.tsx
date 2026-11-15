import { ActionSubmit } from "./action-submit";
import { checkInbox } from "../actions";
import styles from "../team.module.css";

/** "Check inbox now": only rendered when the deployment reads real mail (demoCapabilities). */
export function InboxCheck({ caseId }: { caseId: string }) {
  return (
    <section aria-labelledby="buzon" className={styles.quietCard}>
      <h2 id="buzon" className={styles.subtitle}>
        Mailbox
      </h2>
      <form action={checkInbox}>
        <input type="hidden" name="caseId" value={caseId} />
        <ActionSubmit pendingLabel="Checking inbox…">Check inbox now</ActionSubmit>
      </form>
      <p className={styles.muted}>
        Reads replies sent to the ReTren mailbox; the hourly check does the same.
      </p>
    </section>
  );
}
