"use server";
// Server actions of the team view. Every one re-checks the session first (requireTeam) and then
// uses the service-role client, which never leaves the server. Results go back as a short code
// in the query string (`?aviso=` / `?error=`): ids and codes only, never an address or a body.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServiceClient } from "@/shared/supabase/server";
import {
  DEMO_CLOCK_COOKIE,
  TeamActionError,
  assertDemoCapability,
  checkInboxNow,
  demoNow,
  nextDemoNow,
  resolveQueueItem,
  injectOperatorReply,
  runDemoTick,
} from "../../../features/claims/team";
import {
  TEAM_SESSION_COOKIE,
  revokeTeamSession,
  signInTeamMember,
} from "../../../features/claims/team-access";
import { ingestForTeam } from "../../../features/claims/team-ingest";
import { LOGIN_PATH, requireTeam } from "./_lib/session";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/** Where an action goes back to: the queue, or one case. Anything else falls back to the queue. */
function backTo(f: FormData): string {
  const back = str(f, "back");
  return /^\/equipo(\/casos\/[0-9a-f-]{36})?$/i.test(back) ? back : "/equipo";
}

const withParam = (path: string, key: "aviso" | "error", value: string) =>
  `${path}?${key}=${encodeURIComponent(value)}`;

const secure = () => process.env.NODE_ENV === "production";

export async function login(formData: FormData): Promise<void> {
  const session = await signInTeamMember(str(formData, "email"), str(formData, "password"));
  if (!session) redirect(withParam(LOGIN_PATH, "error", "credenciales"));
  (await cookies()).set(TEAM_SESSION_COOKIE, session.accessToken, {
    httpOnly: true,
    sameSite: "strict",
    secure: secure(),
    path: "/",
    maxAge: session.maxAge,
  });
  redirect("/equipo");
}

export async function logout(): Promise<void> {
  const jar = await cookies();
  // Revoke the session on the Auth server too, not only forget it in this browser.
  await revokeTeamSession(jar.get(TEAM_SESSION_COOKIE)?.value, (jwt) =>
    createServiceClient().auth.admin.signOut(jwt),
  );
  jar.delete(TEAM_SESSION_COOKIE);
  jar.delete(DEMO_CLOCK_COOKIE);
  redirect(LOGIN_PATH);
}

/** Runs a team action and goes back with its result: `ok` is the notice code, errors map to codes. */
async function perform(
  back: string,
  run: () => Promise<{ aviso: string }>,
  after?: () => Promise<void>,
): Promise<never> {
  let target: string;
  try {
    const { aviso } = await run();
    await after?.();
    target = withParam(back, "aviso", aviso);
  } catch (e) {
    target = withParam(back, "error", e instanceof TeamActionError ? e.code : "failed");
  }
  redirect(target);
}

export async function injectReply(formData: FormData): Promise<void> {
  await requireTeam();
  const caseId = str(formData, "caseId");
  const back = /^[0-9a-f-]{36}$/i.test(caseId) ? `/equipo/casos/${caseId}` : "/equipo";
  await perform(back, async () => {
    assertDemoCapability("simulateReply");
    const out = await injectOperatorReply(
      createServiceClient(),
      { caseId, fixture: str(formData, "fixture") },
      { ingest: ingestForTeam },
    );
    return { aviso: `inyectado_${out.outcome}` };
  });
}

export async function advanceClock(formData: FormData): Promise<void> {
  await requireTeam();
  // The clock moves for the case being viewed only.
  const caseId = str(formData, "caseId");
  const jar = await cookies();
  const next = (() => {
    try {
      return nextDemoNow(jar.get(DEMO_CLOCK_COOKIE)?.value, Number(str(formData, "days")));
    } catch {
      return null;
    }
  })();
  await perform(
    backTo(formData),
    async () => {
      assertDemoCapability("clock");
      if (!next || !/^[0-9a-f-]{36}$/i.test(caseId)) throw new TeamActionError("bad_input");
      await runDemoTick(createServiceClient(), next, caseId);
      return { aviso: "reloj_movido" };
    },
    async () => {
      // The demo clock of this browser session only; the real clock is never touched.
      jar.set(DEMO_CLOCK_COOKIE, next!.toISOString(), {
        httpOnly: true,
        sameSite: "strict",
        secure: secure(),
        path: "/",
        maxAge: 60 * 60 * 24,
      });
    },
  );
}

export async function resetClock(formData: FormData): Promise<void> {
  await requireTeam();
  await perform(backTo(formData), async () => {
    assertDemoCapability("clock");
    (await cookies()).delete(DEMO_CLOCK_COOKIE);
    return { aviso: "reloj_reiniciado" };
  });
}

/**
 * Reads the Retren mailbox now and acts on what it finds for the case viewed (real mail only).
 * The notice carries the count of mails read: `buzon_<n>`.
 */
export async function checkInbox(formData: FormData): Promise<void> {
  await requireTeam();
  const caseId = str(formData, "caseId");
  const back = /^[0-9a-f-]{36}$/i.test(caseId) ? `/equipo/casos/${caseId}` : "/equipo";
  const jar = await cookies();
  await perform(back, async () => {
    assertDemoCapability("checkInbox");
    // The same instant the demo clock shows, so "now" is never ahead of what the team sees.
    const now = demoNow(jar.get(DEMO_CLOCK_COOKIE)?.value);
    const out = await checkInboxNow(createServiceClient(), now, caseId, { env: process.env });
    return { aviso: out.connected ? "buzon_conectado" : `buzon_${out.processed}` };
  });
}

export async function resolveItem(formData: FormData): Promise<void> {
  await requireTeam();
  const source = str(formData, "source") === "message" ? "message" : "event";
  await perform(backTo(formData), async () => {
    await resolveQueueItem(createServiceClient(), { source, id: str(formData, "id") });
    return { aviso: "resuelto" };
  });
}
