// The simulated mailbox's way into C4. Internal to domain C.
// The same function the IMAP poller calls (ingestMessage), so a scripted reply is stored,
// classified (C5) and acted on (C6) for real.
import { ingestMessage } from "./inbound";
import type { IngestOutcome } from "./team";

export async function ingestForTeam(raw: string): Promise<IngestOutcome> {
  return ingestMessage(raw);
}
