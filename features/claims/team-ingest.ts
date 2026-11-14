// The simulated mailbox's way into C4. Internal to domain C.
// TODO([C4]): once features/claims/inbound.ts is on develop, replace the body with
// `return ingestMessage(raw)` (it returns the IngestResult, a superset of IngestOutcome).
import type { IngestOutcome } from "./team";

export async function ingestForTeam(raw: string): Promise<IngestOutcome> {
  void raw;
  throw new Error("[C4] ingestMessage is not on develop yet");
}
