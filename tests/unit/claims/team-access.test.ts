import { describe, expect, it, vi } from "vitest";
import {
  signInTeamMember,
  teamAccessMode,
  verifyTeamToken,
  type AuthClient,
} from "@/features/claims/team-access";

// [C9] Who may open /equipo: Supabase Auth plus the allowlist (is_team_member() in the database).
const AUTH_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
};

describe("teamAccessMode", () => {
  it("requires a login whenever Supabase Auth is configured", () => {
    expect(teamAccessMode(AUTH_ENV)).toBe("auth");
    expect(teamAccessMode({ ...AUTH_ENV, DEMO_MODE: "1" })).toBe("auth");
  });

  it("is disabled without auth outside DEMO_MODE", () => {
    expect(teamAccessMode({})).toBe("disabled");
    expect(teamAccessMode({ DEMO_MODE: "0" })).toBe("disabled");
    expect(teamAccessMode({ NEXT_PUBLIC_SUPABASE_URL: AUTH_ENV.NEXT_PUBLIC_SUPABASE_URL })).toBe(
      "disabled",
    );
  });

  it("is open without auth only with DEMO_MODE=1", () => {
    expect(teamAccessMode({ DEMO_MODE: "1" })).toBe("open");
  });
});

function client(over: {
  user?: { email?: string } | null;
  member?: boolean | null;
  signIn?: { access_token: string; expires_in: number } | null;
}): AuthClient {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: over.user ?? null }, error: null })),
      signInWithPassword: vi.fn(async () =>
        over.signIn
          ? { data: { session: over.signIn }, error: null }
          : { data: { session: null }, error: { message: "bad" } },
      ),
    },
    rpc: vi.fn(async () => ({ data: over.member ?? null, error: null })),
  } as unknown as AuthClient;
}

describe("verifyTeamToken", () => {
  it("accepts a valid session of an allowlisted user, asking the database with the user's token", async () => {
    const make = vi.fn(() => client({ user: { email: "a@retren.test" }, member: true }));
    await expect(verifyTeamToken("tok", AUTH_ENV, make)).resolves.toEqual({
      email: "a@retren.test",
    });
    expect(make).toHaveBeenCalledWith("http://127.0.0.1:54321", "anon-key", "tok");
  });

  it("refuses a valid session that is not on the allowlist", async () => {
    const make = () => client({ user: { email: "a@retren.test" }, member: false });
    await expect(verifyTeamToken("tok", AUTH_ENV, make)).resolves.toBeNull();
  });

  it("refuses an invalid token, a missing token and a failed database check", async () => {
    await expect(
      verifyTeamToken("tok", AUTH_ENV, () => client({ user: null })),
    ).resolves.toBeNull();
    await expect(verifyTeamToken(undefined, AUTH_ENV, () => client({}))).resolves.toBeNull();
    await expect(
      verifyTeamToken("tok", AUTH_ENV, () => client({ user: { email: "a@x.test" }, member: null })),
    ).resolves.toBeNull();
  });

  it("refuses everything when auth is not configured", async () => {
    await expect(verifyTeamToken("tok", {}, () => client({}))).resolves.toBeNull();
  });
});

describe("signInTeamMember", () => {
  const session = { access_token: "tok", expires_in: 3600 };

  it("returns the token of an allowlisted user", async () => {
    const make = (_u: string, _k: string, token?: string) =>
      token
        ? client({ user: { email: "a@retren.test" }, member: true })
        : client({ signIn: session });
    await expect(signInTeamMember("A@Retren.test", "pw", AUTH_ENV, make)).resolves.toEqual({
      accessToken: "tok",
      maxAge: 3600,
    });
  });

  it("refuses wrong credentials", async () => {
    const make = () => client({ signIn: null });
    await expect(signInTeamMember("a@retren.test", "bad", AUTH_ENV, make)).resolves.toBeNull();
  });

  it("refuses a user who signs in fine but is not on the allowlist", async () => {
    const make = (_u: string, _k: string, token?: string) =>
      token ? client({ user: { email: "a@x.test" }, member: false }) : client({ signIn: session });
    await expect(signInTeamMember("a@x.test", "pw", AUTH_ENV, make)).resolves.toBeNull();
  });
});
