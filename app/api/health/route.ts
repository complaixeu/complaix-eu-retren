// Liveness probe used by the dev deploy smoke check.
export function GET() {
  return Response.json({ status: "ok" });
}
