import { type DemoCapabilities, listFixtures } from "../../../../features/claims/team";
import { injectReply } from "../actions";
import { ActionSubmit } from "./action-submit";
import { ClockPanel } from "./clock-panel";
import { InboxCheck } from "./inbox-check";
import styles from "../team.module.css";

/**
 * The case page's demo tools. Which ones show is decided by demoCapabilities (the page passes
 * it in): fake mail gets the simulated reply, real mail gets "Check inbox now", and both get the
 * clock where the deployment has it.
 */
export function DemoControls({
  caps,
  caseId,
  back,
  operator,
  now,
}: {
  caps: DemoCapabilities;
  caseId: string;
  back: string;
  operator: string;
  now: string;
}) {
  const fixtures = caps.simulateReply ? listFixtures(operator) : [];
  return (
    <div className={styles.demoControls}>
      {caps.simulateReply && (
        <section aria-labelledby="inyectar" className={styles.quietCard}>
          <h2 id="inyectar" className={styles.subtitle}>
            Simulate an operator reply
          </h2>
          {fixtures.length === 0 ? (
            <p>No reply fixtures are available for this operator.</p>
          ) : (
            <form action={injectReply} className={styles.inline}>
              <input type="hidden" name="caseId" value={caseId} />
              <label className={styles.label}>
                Reply fixture
                <select name="fixture" className={styles.select} required>
                  {fixtures.map((f) => (
                    <option key={f.name} value={f.name}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <ActionSubmit pendingLabel="Processing reply…">Simulate reply</ActionSubmit>
            </form>
          )}
          <p className={styles.muted}>
            The reply follows the real inbound path: it is stored, classified, and acted on.
          </p>
        </section>
      )}

      {caps.clock && <ClockPanel now={now} back={back} caseId={caseId} />}
      {caps.checkInbox && <InboxCheck caseId={caseId} />}
    </div>
  );
}
