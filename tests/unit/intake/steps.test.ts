import { describe, expect, it } from "vitest";
import {
  INTAKE_STEPS,
  intakeStepFromPathname,
  intakeStepHref,
  intakeStepNeighbours,
  intakeStepperItems,
} from "@/features/intake/steps";
import { stepStatuses } from "@/shared/ui/stepper-state";
import { fieldAria } from "@/shared/ui/field-aria";

describe("intake step list", () => {
  it("has the five steps of the flow, in order, each with a label and a heading", () => {
    expect(INTAKE_STEPS.map((s) => s.id)).toEqual([
      "foto",
      "revision",
      "preguntas",
      "mandato",
      "enviado",
    ]);
    for (const step of INTAKE_STEPS) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.title.length).toBeGreaterThan(0);
    }
  });

  it("builds the href of every step under /reclamar", () => {
    expect(intakeStepHref("foto")).toBe("/reclamar/foto");
    expect(intakeStepHref("enviado")).toBe("/reclamar/enviado");
  });

  it("finds the step from a pathname, ignoring a trailing slash", () => {
    expect(intakeStepFromPathname("/reclamar/revision")).toBe("revision");
    expect(intakeStepFromPathname("/reclamar/mandato/")).toBe("mandato");
  });

  it("returns null for a pathname that is not a step", () => {
    expect(intakeStepFromPathname("/")).toBeNull();
    expect(intakeStepFromPathname("/reclamar")).toBeNull();
    expect(intakeStepFromPathname("/reclamar/otra")).toBeNull();
    expect(intakeStepFromPathname("/reclamar/foto/extra")).toBeNull();
    expect(intakeStepFromPathname("/otra/foto")).toBeNull();
  });

  it("gives the previous and next step, with none before the first or after the last", () => {
    expect(intakeStepNeighbours("foto")).toEqual({ previous: null, next: "revision" });
    expect(intakeStepNeighbours("preguntas")).toEqual({ previous: "revision", next: "mandato" });
    expect(intakeStepNeighbours("enviado")).toEqual({ previous: "mandato", next: null });
  });
});

describe("intake stepper items", () => {
  it("marks earlier steps complete, one current and later ones upcoming", () => {
    const items = intakeStepperItems("preguntas");
    expect(items.map((i) => i.status)).toEqual([
      "complete",
      "complete",
      "current",
      "upcoming",
      "upcoming",
    ]);
    expect(items.filter((i) => i.status === "current")).toHaveLength(1);
  });

  it("links only completed steps, so nobody can jump ahead", () => {
    const items = intakeStepperItems("preguntas");
    expect(items.map((i) => i.href)).toEqual([
      "/reclamar/foto",
      "/reclamar/revision",
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("links nothing once the claim is sent: there is no going back to edit it", () => {
    const items = intakeStepperItems("enviado");
    expect(items.every((i) => i.href === undefined)).toBe(true);
    expect(items.at(-1)?.status).toBe("current");
  });

  it("links nothing on the first step", () => {
    const items = intakeStepperItems("foto");
    expect(items[0]).toMatchObject({ status: "current", href: undefined });
    expect(items.slice(1).every((i) => i.status === "upcoming")).toBe(true);
  });
});

describe("stepStatuses", () => {
  it("returns one status per step around the current index", () => {
    expect(stepStatuses(3, 0)).toEqual(["current", "upcoming", "upcoming"]);
    expect(stepStatuses(3, 2)).toEqual(["complete", "complete", "current"]);
  });

  it("rejects a current index outside the list", () => {
    expect(() => stepStatuses(3, -1)).toThrow(RangeError);
    expect(() => stepStatuses(3, 3)).toThrow(RangeError);
    expect(() => stepStatuses(3, 1.5)).toThrow(RangeError);
  });
});

describe("fieldAria", () => {
  it("describes the control by nothing when there is no help and no error", () => {
    expect(fieldAria("email", {})).toEqual({
      helpId: undefined,
      errorId: undefined,
      describedBy: undefined,
      invalid: undefined,
    });
  });

  it("points aria-describedby at the error first, then the help text", () => {
    expect(fieldAria("email", { help: true, error: true })).toEqual({
      helpId: "email-help",
      errorId: "email-error",
      describedBy: "email-error email-help",
      invalid: true,
    });
  });

  it("marks the control invalid only when there is an error", () => {
    expect(fieldAria("email", { help: true }).invalid).toBeUndefined();
    expect(fieldAria("email", { help: true }).describedBy).toBe("email-help");
    expect(fieldAria("email", { error: true }).invalid).toBe(true);
  });
});
