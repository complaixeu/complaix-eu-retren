import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TeamActionError,
  assertDemoMode,
  demoNow,
  listFixtures,
  nextDemoNow,
  scriptedReply,
} from "@/features/claims/team";
import { fixedClock } from "@/shared/clock";

// [C9] The pure parts of the team view: the demo gate, the demo clock, the fixture rewrite.
const FIXTURE = [
  "From: Iryo Atencion al Cliente <atencion.cliente@iryo.eu>",
  "To: Retren Reclamaciones <reclamaciones@retren.example>",
  "Subject: Re: Reclamacion por retraso [RTN-T004]",
  "Message-ID: <fixture-asks_for_data-01@mail.example>",
  "In-Reply-To: <claim-rtn-t004@retren.example>",
  "References: <claim-rtn-t004@retren.example>",
  "  <older@retren.example>",
  "MIME-Version: 1.0",
  "",
  "Necesitamos el IBAN. Referencia RTN-T004.",
  "",
].join("\n");

const opts = {
  fixture: "asks_for_data-01",
  publicRef: "RTN-ABCD1234",
  initialMessageId: "<claim.real@retren.example>",
  messageId: "<scripted-1@mail.example>",
};

describe("assertDemoMode", () => {
  it("passes only with DEMO_MODE=1", () => {
    expect(() => assertDemoMode({ DEMO_MODE: "1" })).not.toThrow();
    for (const env of [{}, { DEMO_MODE: "0" }, { DEMO_MODE: "true" }]) {
      expect(() => assertDemoMode(env)).toThrow(TeamActionError);
    }
  });
});

describe("the demo clock", () => {
  const clock = fixedClock("2030-03-01T10:00:00.000Z");

  it("is the real clock until it is moved, and ignores bad or past values", () => {
    expect(demoNow(undefined, clock).toISOString()).toBe("2030-03-01T10:00:00.000Z");
    expect(demoNow("nonsense", clock).toISOString()).toBe("2030-03-01T10:00:00.000Z");
    expect(demoNow("2020-01-01T00:00:00.000Z", clock).toISOString()).toBe(
      "2030-03-01T10:00:00.000Z",
    );
  });

  it("moves forward by whole days, from the stored instant", () => {
    const first = nextDemoNow(undefined, 30, clock);
    expect(first.toISOString()).toBe("2030-03-31T10:00:00.000Z");
    expect(nextDemoNow(first.toISOString(), 15, clock).toISOString()).toBe(
      "2030-04-15T10:00:00.000Z",
    );
  });

  it("refuses zero, negative, fractional and absurd steps", () => {
    for (const days of [0, -1, 1.5, 401, Number.NaN]) {
      expect(() => nextDemoNow(undefined, days, clock)).toThrow(TeamActionError);
    }
  });
});

describe("scriptedReply", () => {
  const out = scriptedReply(FIXTURE, opts);
  const [head = "", body = ""] = out.split("\r\n\r\n");

  it("sets a fresh Message-ID and threads onto the case's initial claim", () => {
    expect(head).toContain("Message-ID: <scripted-1@mail.example>");
    expect(head).not.toContain("fixture-asks_for_data-01");
    expect(head).toContain("In-Reply-To: <claim.real@retren.example>");
    expect(head).toContain("References: <claim.real@retren.example>");
    expect(head).not.toContain("older@retren.example");
    expect(head.match(/^Message-ID:/gim)).toHaveLength(1);
  });

  it("uses the case's reference, in the subject and the body", () => {
    expect(head).toContain("Subject: Re: Reclamacion por retraso [RTN-ABCD1234]");
    expect(body).toContain("RTN-ABCD1234");
    expect(out).not.toContain("RTN-T004");
  });

  it("keeps the other headers and the body", () => {
    expect(head).toContain("From: Iryo Atencion al Cliente <atencion.cliente@iryo.eu>");
    expect(head).toContain("MIME-Version: 1.0");
    expect(body).toContain("Necesitamos el IBAN.");
  });

  it("keeps the threading and reference of a spoofed-reference fixture", () => {
    const spoof = scriptedReply(FIXTURE.replace("T004", "ZZZZ"), {
      ...opts,
      fixture: "spoofed-ref-01",
    });
    expect(spoof).toContain("[RTN-ZZZZ]");
    expect(spoof).toContain("In-Reply-To: <claim-rtn-t004@retren.example>");
    expect(spoof).toContain("Message-ID: <scripted-1@mail.example>");
  });
});

describe("listFixtures", () => {
  it("lists the fixtures of an operator, labelled, and nothing for an unknown one", () => {
    const dir = mkdtempSync(join(tmpdir(), "c9-fixtures-"));
    mkdirSync(join(dir, "iryo"));
    for (const f of ["approved-01.eml", "asks_for_data-02.eml", "notes.txt", "odd name.eml"]) {
      writeFileSync(join(dir, "iryo", f), "x");
    }
    const env = { TEAM_FIXTURES_DIR: dir };
    expect(listFixtures("iryo", env).map((f) => f.name)).toEqual([
      "approved-01",
      "asks_for_data-02",
    ]);
    expect(listFixtures("iryo", env)[1]?.label).toContain("IBAN");
    expect(listFixtures("renfe", env)).toEqual([]);
    expect(listFixtures("../etc", env)).toEqual([]);
  });
});
