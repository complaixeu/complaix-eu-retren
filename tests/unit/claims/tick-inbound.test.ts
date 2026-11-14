import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The tick reads the mailbox (C4) only when MAIL_PROVIDER=gmail, and before the timer actions,
// so an operator reply stops the schedule before a reminder is queued.
const order: string[] = [];
const poll = vi.fn(async () => {
  order.push("poll");
  return { started: "resumed", processed: 0, skipped: 0 };
});

vi.mock("@/features/claims/poll-inbox", () => ({ pollInbox: poll }));
vi.mock("@/features/claims/tick", async (orig) => ({
  ...(await orig<typeof import("@/features/claims/tick")>()),
  runTick: vi.fn(async (_db: unknown, now: Date) => {
    order.push("timers");
    return { now: now.toISOString(), actions: [], skipped: [], failed: [] };
  }),
}));
vi.mock("@/features/claims/outbound-tick", () => ({
  runOutbound: vi.fn(async () => {
    order.push("outbound");
    return { initialClaims: [], sent: [] };
  }),
}));
vi.mock("@/shared/supabase/server", () => ({ createServiceClient: () => ({}) }));

const { POST } = await import("@/app/api/claims/tick/route");
const { runInbound } = await import("@/features/claims/inbound-tick");

const SECRET = "test-tick-secret";
const call = () =>
  POST(
    new Request("http://127.0.0.1/api/claims/tick", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: "{}",
    }),
  );

describe("the tick and the mailbox", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    order.length = 0;
    poll.mockClear();
    process.env.TICK_SECRET = SECRET;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("MAIL_PROVIDER=gmail: polls the inbox first, then the timers, then the outbound", async () => {
    process.env.MAIL_PROVIDER = "gmail";
    const res = await call();
    expect(res.status).toBe(200);
    expect(order).toEqual(["poll", "timers", "outbound"]);
    expect((await res.json()).inbound).toMatchObject({ processed: 0 });
  });

  it("MAIL_PROVIDER=fake (the default): never touches a mailbox", async () => {
    delete process.env.MAIL_PROVIDER;
    const res = await call();
    expect(res.status).toBe(200);
    expect(poll).not.toHaveBeenCalled();
    expect(order).toEqual(["timers", "outbound"]);
  });

  it("a mailbox that fails or refuses to start never stops the timers", async () => {
    process.env.MAIL_PROVIDER = "gmail";
    poll.mockImplementationOnce(async () => {
      throw new Error("MAIL_REDIRECT_ALL_TO must be a different mailbox from SMTP_USER");
    });
    const res = await call();
    expect(res.status).toBe(200);
    expect(order).toEqual(["timers", "outbound"]);
    // A code only: never the error text (it may name a mailbox).
    expect((await res.json()).inbound).toEqual({ error: "inbound_failed" });
  });

  it("runInbound answers `skipped` for the fake provider", async () => {
    expect(await runInbound({} as never, new Date(), { MAIL_PROVIDER: "fake" })).toEqual({
      skipped: "mail_provider_fake",
    });
    expect(poll).not.toHaveBeenCalled();
  });
});
