import { ActionSubmit } from "./action-submit";
import { resolveItem } from "../actions";

/** Marks one queue item as handled (appends an event; nothing is deleted). */
export function ResolveForm({
  id,
  source,
  back,
  label,
}: {
  id: string;
  source: "event" | "message";
  back: string;
  /** Says which item the button is for, for screen readers. */
  label: string;
}) {
  return (
    <form action={resolveItem}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="source" value={source} />
      <input type="hidden" name="back" value={back} />
      <ActionSubmit
        pendingLabel="Saving…"
        variant="secondary"
        aria-label={`Mark as resolved: ${label}`}
      >
        Mark as resolved
      </ActionSubmit>
    </form>
  );
}
