import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Notice } from "@/app/(team)/equipo/_components/notice";

// [C9] What the team view says after an action: codes in the query string, mapped to English.
const show = (aviso?: string, error?: string) =>
  renderToStaticMarkup(createElement(Notice, { aviso, error }));

describe("the inbox notices", () => {
  it("counts the emails read, singular and plural", () => {
    expect(show("buzon_1")).toContain("Inbox checked: 1 new email");
    expect(show("buzon_0")).toContain("Inbox checked: 0 new emails");
    expect(show("buzon_3")).toContain("Inbox checked: 3 new emails");
  });

  it("says the inbox is connected on the first check, and that nothing older is read", () => {
    expect(show("buzon_conectado")).toContain(
      "Inbox connected. Replies that arrive from now on will be read.",
    );
    expect(show("buzon_conectado")).not.toContain("Inbox checked");
  });

  it("maps the mail errors to fixed texts, and any other code to the generic one", () => {
    expect(show(undefined, "mail_config")).toContain("Mail settings are incomplete.");
    expect(show(undefined, "inbound_failed")).toContain("Could not read the mailbox.");
    expect(show(undefined, "send_failed")).toContain("Could not send the queued mail.");
    expect(show(undefined, "something_else")).toContain("Could not complete the action.");
  });
});
