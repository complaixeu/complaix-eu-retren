import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

describe("local Supabase (integration smoke)", () => {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;

  it("points at 127.0.0.1, never a remote project", () => {
    expect(url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost):/);
  });

  it("REST answers with the anon key", async () => {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! },
    });
    expect(res.status).toBe(200);
  });

  it("storage answers with the service role", async () => {
    const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
    const { error } = await admin.storage.listBuckets();
    expect(error).toBeNull();
  });

  it("uses fake providers only", () => {
    expect([process.env.OCR_PROVIDER, process.env.LLM_PROVIDER, process.env.MAIL_PROVIDER]).toEqual(
      ["fake", "fake", "fake"],
    );
  });
});
