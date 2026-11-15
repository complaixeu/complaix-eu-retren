import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TeamActionError,
  demoNow,
  listFixtures,
  nextDemoNow,
  scriptedReply,
} from "@/features/claims/team";
import { DEMO_FIXTURES } from "@/features/claims/demo-fixtures";
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

// The demo rule itself (which tool each mail setup gets) is in demo-capabilities.test.ts.

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
    const fx = {
      iryo: {
        "approved-01": "x",
        "asks_for_data-02": "x",
        "injection-01": "x",
        "odd name": "x",
      },
    };
    expect(listFixtures("iryo", fx).map((f) => f.name)).toEqual([
      "approved-01",
      "asks_for_data-02",
      "injection-01",
    ]);
    expect(listFixtures("iryo", fx)[1]?.label).toContain("IBAN");
    expect(listFixtures("iryo", fx).find((f) => f.name === "approved-01")?.label).toBe(
      "Approved (01)",
    );
    expect(listFixtures("iryo", fx).find((f) => f.name === "injection-01")?.label).toBe(
      "Malicious email (prompt injection) (01)",
    );
    expect(listFixtures("renfe", fx)).toEqual([]);
    expect(listFixtures("../etc", fx)).toEqual([]);
  });

  it("bundles every operator's golden .eml, byte for byte (regenerate features/claims/demo-fixtures.ts)", () => {
    const root = join(process.cwd(), "tests", "fixtures", "mail");
    for (const op of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory())) {
      const files = readdirSync(join(root, op)).filter((f) => f.endsWith(".eml"));
      expect(Object.keys(DEMO_FIXTURES[op] ?? {}).sort()).toEqual(
        files.map((f) => f.slice(0, -4)).sort(),
      );
      for (const f of files) {
        expect(DEMO_FIXTURES[op]?.[f.slice(0, -4)]).toBe(readFileSync(join(root, op, f), "utf8"));
      }
    }
  });
});
