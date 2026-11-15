import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TeamActionError } from "@/features/claims/team";

// [C9] Every server action re-checks the session itself: an action is a public endpoint, so a
// visitor without a team session must reach neither the database nor the demo tools, whatever
// the page showed. Next's request APIs and the claims code are replaced by spies.
const mocks = vi.hoisted(() => ({
  token: undefined as string | undefined,
  cookieSet: vi.fn(),
  cookieDelete: vi.fn(),
  signOut: vi.fn(async () => ({ error: null })),
  createServiceClient: vi.fn(() => ({
    from: vi.fn(),
    auth: { admin: { signOut: mocks.signOut } },
  })),
  injectOperatorReply: vi.fn(async () => ({ outcome: "applied" })),
  resolveQueueItem: vi.fn(async () => undefined),
  runDemoTick: vi.fn(async () => ({})),
  checkInboxNow: vi.fn(async () => ({ processed: 2, connected: false })),
  verifyTeamToken: vi.fn(async (token: string | undefined) =>
    token === "good" ? { email: "a@retren.test" } : null,
  ),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "retren_team_at" && mocks.token ? { value: mocks.token } : undefined,
    set: mocks.cookieSet,
    delete: mocks.cookieDelete,
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/shared/supabase/server", () => ({ createServiceClient: mocks.createServiceClient }));
vi.mock("@/features/claims/team-access", async (orig) => ({
  ...(await orig<typeof import("@/features/claims/team-access")>()),
  verifyTeamToken: mocks.verifyTeamToken,
}));
vi.mock("@/features/claims/team-ingest", () => ({ ingestForTeam: vi.fn() }));
vi.mock("@/features/claims/team", async (orig) => ({
  ...(await orig<typeof import("@/features/claims/team")>()),
  injectOperatorReply: mocks.injectOperatorReply,
  resolveQueueItem: mocks.resolveQueueItem,
  runDemoTick: mocks.runDemoTick,
  checkInboxNow: mocks.checkInboxNow,
}));

const ID = "11111111-1111-4111-8111-111111111111";
const form = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

const saved = { ...process.env };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.token = undefined;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.DEMO_MODE = "1";
});
afterEach(() => {
  process.env = { ...saved };
});

async function actions() {
  return import("@/app/(team)/equipo/actions");
}

describe("without a team session", () => {
  const calls: [string, Record<string, string>][] = [
    ["injectReply", { caseId: ID, fixture: "approved-01" }],
    ["advanceClock", { days: "30", caseId: ID }],
    ["resetClock", {}],
    ["resolveItem", { id: ID, source: "event" }],
    ["checkInbox", { caseId: ID }],
  ];

  it.each(calls)("%s sends the visitor to the login and touches nothing", async (name, data) => {
    const a = (await actions()) as unknown as Record<string, (f: FormData) => Promise<void>>;
    await expect(a[name]!(form(data))).rejects.toThrow("REDIRECT /equipo/entrar");
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
    expect(mocks.injectOperatorReply).not.toHaveBeenCalled();
    expect(mocks.resolveQueueItem).not.toHaveBeenCalled();
    expect(mocks.runDemoTick).not.toHaveBeenCalled();
    expect(mocks.checkInboxNow).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("refuses a token that is not a team member's", async () => {
    mocks.token = "stolen-or-outsider";
    const a = await actions();
    await expect(a.resolveItem(form({ id: ID, source: "event" }))).rejects.toThrow(
      "REDIRECT /equipo/entrar",
    );
    expect(mocks.resolveQueueItem).not.toHaveBeenCalled();
  });

  it("is a 404 for everything when auth is off and DEMO_MODE is off", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.DEMO_MODE = "0";
    const a = await actions();
    await expect(a.resolveItem(form({ id: ID, source: "event" }))).rejects.toThrow("NOT_FOUND");
    expect(mocks.createServiceClient).not.toHaveBeenCalled();
  });
});

describe("logout", () => {
  it("revokes the session on the Auth server and clears the cookies", async () => {
    mocks.token = "good";
    const a = await actions();
    await expect(a.logout()).rejects.toThrow("REDIRECT /equipo/entrar");
    expect(mocks.signOut).toHaveBeenCalledWith("good");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("retren_team_at");
  });

  it("clears the cookies even when the revoke fails", async () => {
    mocks.token = "good";
    mocks.signOut.mockRejectedValueOnce(new Error("down"));
    const a = await actions();
    await expect(a.logout()).rejects.toThrow("REDIRECT /equipo/entrar");
    expect(mocks.cookieDelete).toHaveBeenCalledWith("retren_team_at");
  });
});

describe("with a team session", () => {
  beforeEach(() => {
    mocks.token = "good";
  });

  it("injects through the claims code and goes back to the case with a code", async () => {
    const a = await actions();
    await expect(a.injectReply(form({ caseId: ID, fixture: "approved-01" }))).rejects.toThrow(
      `REDIRECT /equipo/casos/${ID}?aviso=inyectado_applied`,
    );
    expect(mocks.injectOperatorReply).toHaveBeenCalledWith(
      expect.anything(),
      { caseId: ID, fixture: "approved-01" },
      expect.objectContaining({ ingest: expect.any(Function) }),
    );
  });

  it("does not inject outside DEMO_MODE", async () => {
    process.env.DEMO_MODE = "0";
    const a = await actions();
    await expect(a.injectReply(form({ caseId: ID, fixture: "approved-01" }))).rejects.toThrow(
      `REDIRECT /equipo/casos/${ID}?error=demo_only`,
    );
    expect(mocks.injectOperatorReply).not.toHaveBeenCalled();
  });

  it("does not move the clock without a case", async () => {
    const a = await actions();
    await expect(a.advanceClock(form({ days: "30" }))).rejects.toThrow("?error=bad_input");
    expect(mocks.runDemoTick).not.toHaveBeenCalled();
  });

  it("does not move the clock outside DEMO_MODE, and ignores a bad step", async () => {
    const a = await actions();
    await expect(a.advanceClock(form({ days: "0", caseId: ID }))).rejects.toThrow(
      "?error=bad_input",
    );
    process.env.DEMO_MODE = "0";
    await expect(a.advanceClock(form({ days: "30", caseId: ID }))).rejects.toThrow(
      "?error=demo_only",
    );
    expect(mocks.runDemoTick).not.toHaveBeenCalled();
    expect(mocks.cookieSet).not.toHaveBeenCalled();
  });

  it("answers a reset outside DEMO_MODE with an error redirect, not a crash", async () => {
    process.env.DEMO_MODE = "0";
    const a = await actions();
    await expect(a.resetClock(form({}))).rejects.toThrow("REDIRECT /equipo?error=demo_only");
    expect(mocks.cookieDelete).not.toHaveBeenCalled();
  });

  it("only goes back to the team pages, whatever `back` says", async () => {
    const a = await actions();
    await expect(
      a.resolveItem(form({ id: ID, source: "event", back: "https://evil.example/" })),
    ).rejects.toThrow("REDIRECT /equipo?aviso=resuelto");
    await expect(
      a.resolveItem(form({ id: ID, source: "event", back: `/equipo/casos/${ID}` })),
    ).rejects.toThrow(`REDIRECT /equipo/casos/${ID}?aviso=resuelto`);
  });

  it("moves the clock forward and keeps the demo clock in this session's cookie", async () => {
    const a = await actions();
    await expect(a.advanceClock(form({ days: "30", caseId: ID }))).rejects.toThrow(
      "?aviso=reloj_movido",
    );
    expect(mocks.runDemoTick).toHaveBeenCalledTimes(1);
    // Scoped to the case that was being viewed.
    expect(mocks.runDemoTick).toHaveBeenCalledWith(expect.anything(), expect.any(Date), ID);
    expect(mocks.cookieSet).toHaveBeenCalledWith(
      "retren_demo_now",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      expect.objectContaining({ httpOnly: true }),
    );
  });
});

// [C9] Real mail on DEV: gmail with a redirect outside production. The clock and "Check inbox
// now" are allowed; a simulated reply and anything in production are refused with demo_only.
describe("with real mail (gmail, redirected, not production)", () => {
  const REAL = {
    MAIL_PROVIDER: "gmail",
    MAIL_REDIRECT_ALL_TO: "team@example.com",
    SMTP_USER: "retren@example.com",
  };
  beforeEach(() => {
    mocks.token = "good";
    Object.assign(process.env, REAL);
  });

  it("moves the clock", async () => {
    const a = await actions();
    await expect(a.advanceClock(form({ days: "30", caseId: ID }))).rejects.toThrow(
      "?aviso=reloj_movido",
    );
    expect(mocks.runDemoTick).toHaveBeenCalledTimes(1);
  });

  it("refuses the clock in production, even with the redirect", async () => {
    process.env.RETREN_ENV = "production";
    const a = await actions();
    // No `back` in the form, so it goes back to the queue.
    await expect(a.advanceClock(form({ days: "30", caseId: ID }))).rejects.toThrow(
      "REDIRECT /equipo?error=demo_only",
    );
    expect(mocks.runDemoTick).not.toHaveBeenCalled();
  });

  it("refuses a simulated reply", async () => {
    const a = await actions();
    await expect(a.injectReply(form({ caseId: ID, fixture: "approved-01" }))).rejects.toThrow(
      `REDIRECT /equipo/casos/${ID}?error=demo_only`,
    );
    expect(mocks.injectOperatorReply).not.toHaveBeenCalled();
  });

  it("checks the inbox for the case viewed and reports how many emails were read", async () => {
    const a = await actions();
    await expect(a.checkInbox(form({ caseId: ID }))).rejects.toThrow(
      `REDIRECT /equipo/casos/${ID}?aviso=buzon_2`,
    );
    expect(mocks.checkInboxNow).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Date),
      ID,
      expect.anything(),
    );
  });

  it("says the inbox is connected on the first check, not that zero emails were read", async () => {
    mocks.checkInboxNow.mockResolvedValueOnce({ processed: 0, connected: true });
    const a = await actions();
    await expect(a.checkInbox(form({ caseId: ID }))).rejects.toThrow(
      `REDIRECT /equipo/casos/${ID}?aviso=buzon_conectado`,
    );
  });

  it("refuses the inbox check and the clock without team Auth (open mode)", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const a = await actions();
    await expect(a.checkInbox(form({ caseId: ID }))).rejects.toThrow(
      `REDIRECT /equipo/casos/${ID}?error=demo_only`,
    );
    await expect(a.advanceClock(form({ days: "30", caseId: ID }))).rejects.toThrow(
      "REDIRECT /equipo?error=demo_only",
    );
    expect(mocks.checkInboxNow).not.toHaveBeenCalled();
    expect(mocks.runDemoTick).not.toHaveBeenCalled();
  });

  it("answers mail settings that are incomplete with their code only", async () => {
    mocks.checkInboxNow.mockRejectedValueOnce(new TeamActionError("mail_config"));
    const a = await actions();
    await expect(a.checkInbox(form({ caseId: ID }))).rejects.toThrow(
      `REDIRECT /equipo/casos/${ID}?error=mail_config`,
    );
  });

  it("answers any other failure with the generic code, never its text", async () => {
    mocks.checkInboxNow.mockRejectedValueOnce(new Error("imap login failed for team@example.com"));
    const a = await actions();
    let err: Error | undefined;
    try {
      await a.checkInbox(form({ caseId: ID }));
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe(`REDIRECT /equipo/casos/${ID}?error=failed`);
    expect(err?.message).not.toContain("example.com");
  });

  it("does not check the inbox with the fake mail", async () => {
    delete process.env.MAIL_PROVIDER;
    const a = await actions();
    await expect(a.checkInbox(form({ caseId: ID }))).rejects.toThrow(
      `REDIRECT /equipo/casos/${ID}?error=demo_only`,
    );
    expect(mocks.checkInboxNow).not.toHaveBeenCalled();
  });
});
