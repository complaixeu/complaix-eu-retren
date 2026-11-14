import { Button } from "@/shared/ui";
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
      <Button type="submit" variant="secondary" aria-label={`Marcar como resuelto: ${label}`}>
        Marcar como resuelto
      </Button>
    </form>
  );
}
