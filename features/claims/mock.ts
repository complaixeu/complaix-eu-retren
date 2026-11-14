// Mock of domain C (claims). Same exports and types as the real one.
import { evaluateEligibility } from "@/features/rules";
import { CreateCaseResult, IntakeSubmission } from "@/shared/contracts";

const madrid = (date: string, time: string) => `${date}T${time}:00+01:00`;

export async function createCase(input: IntakeSubmission): Promise<CreateCaseResult> {
  const submission = IntakeSubmission.parse(input);
  const { ticket, answers } = submission;
  const eligibility = evaluateEligibility({
    operator: ticket.operator,
    scheduledDeparture: madrid(ticket.travelDate, ticket.scheduledDeparture),
    scheduledArrival: madrid(ticket.travelDate, ticket.scheduledArrival),
    actualArrival: madrid(answers.actualArrival.date, answers.actualArrival.time),
    purchaseDate: ticket.purchaseDate,
    purchaseChannel: ticket.purchaseChannel,
    now: new Date().toISOString(),
  });
  return CreateCaseResult.parse({
    caseId: `mock-${submission.draftId}`,
    publicRef: "RTN-MOCK",
    status: eligibility.status === "not_eligible" ? "closed" : "waiting_period",
    eligibility,
  });
}
