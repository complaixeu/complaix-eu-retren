import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DemoCapabilities } from "@/features/claims/team";

// [C9] The case page's demo controls, rendered from the capabilities the page computes. Real mail
// shows "Check inbox now" and not "Simulate reply"; fake mail the other way round.
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: () => undefined, notFound: () => undefined }));
vi.mock("next/server", () => ({ connection: async () => undefined }));
vi.mock("@/shared/supabase/server", () => ({ createServiceClient: () => ({}) }));

const { DemoControls } = await import("@/app/(team)/equipo/_components/demo-controls");

const REAL: DemoCapabilities = { clock: true, simulateReply: false, checkInbox: true };
const FAKE: DemoCapabilities = { clock: true, simulateReply: true, checkInbox: false };
const NONE: DemoCapabilities = { clock: false, simulateReply: false, checkInbox: false };

const render = (caps: DemoCapabilities) =>
  renderToStaticMarkup(
    createElement(DemoControls, {
      caps,
      caseId: "11111111-1111-4111-8111-111111111111",
      back: "/equipo/casos/11111111-1111-4111-8111-111111111111",
      operator: "iryo",
      now: "2030-03-01T10:00:00.000Z",
    }),
  );

describe("the case page's demo controls", () => {
  it("with real mail: Check inbox now and the clock, and no simulated reply", () => {
    const html = render(REAL);
    expect(html).toContain("Check inbox now");
    expect(html).toContain("Reads replies sent to the ReTren mailbox");
    expect(html).toContain("Simulated clock");
    expect(html).not.toContain("Simulate reply");
    expect(html).not.toContain("Simulate an operator reply");
  });

  it("with fake mail: the clock and the simulated reply, and no inbox check", () => {
    const html = render(FAKE);
    expect(html).toContain("Simulate reply");
    expect(html).toContain("Simulated clock");
    expect(html).not.toContain("Check inbox now");
  });

  it("with no demo tools: nothing", () => {
    const html = render(NONE);
    expect(html).not.toContain("Check inbox now");
    expect(html).not.toContain("Simulate reply");
    expect(html).not.toContain("Simulated clock");
  });
});
