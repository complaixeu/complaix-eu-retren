import { describe, expect, it } from "vitest";
import { CaseStatus, ReplyCategory } from "@/shared/contracts";
import { Constants } from "@/shared/supabase";

// The DB enums (migration *_claims_create_cases.sql, via the generated types) must match the
// contracts exactly, in the same order.
describe("generated DB enums match shared/contracts", () => {
  it("case_status = CaseStatus", () => {
    expect([...Constants.public.Enums.case_status]).toEqual(CaseStatus.options);
  });
  it("reply_category = ReplyCategory", () => {
    expect([...Constants.public.Enums.reply_category]).toEqual(ReplyCategory.options);
  });
});
