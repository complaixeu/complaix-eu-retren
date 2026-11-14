import { describe, expect, it } from "vitest";
import { purgeExpiredDrafts } from "@/features/intake/draft/purge";
import { DRAFT_TTL_MS } from "@/features/intake/draft/ttl";
import type { ServiceClient } from "@/shared/supabase/server";

// [A1 follow-up] The purge walks Storage listings page by page, so a bucket with more objects
// than one page holds is purged completely.

const NOW = new Date("2026-03-12T10:00:00.000Z");
const OLD = new Date(NOW.getTime() - DRAFT_TTL_MS - 60_000).toISOString();
const FRESH = new Date(NOW.getTime() - 60_000).toISOString();

function fakeClient(
  objects: Record<string, { name: string; created_at: string }[]>,
  live: string[],
) {
  const listCalls: { folder: string; offset: number; limit: number }[] = [];
  const removed: string[] = [];
  const ok = <T>(data: T) => Promise.resolve({ data, error: null });
  const client = {
    from: () => ({
      delete: () => ({ lte: () => ({ select: () => ok([]) }) }),
      select: () => ({
        in: (_column: string, paths: string[]) =>
          ok(paths.filter((p) => live.includes(p)).map((p) => ({ ticket_path: p }))),
      }),
    }),
    storage: {
      from: () => ({
        list: (folder: string, options: { limit: number; offset: number }) => {
          listCalls.push({ folder, offset: options.offset, limit: options.limit });
          const page = (objects[folder] ?? []).slice(
            options.offset,
            options.offset + options.limit,
          );
          return ok(page.map((o, i) => ({ id: `${folder}-${options.offset + i}`, ...o })));
        },
        remove: (paths: string[]) => {
          removed.push(...paths);
          return ok([]);
        },
      }),
    },
  };
  return { db: client as unknown as ServiceClient, listCalls, removed };
}

describe("purgeExpiredDrafts: Storage listing pagination", () => {
  it("reads every page, and purges old orphans found on any of them", async () => {
    const drafts = Array.from({ length: 5 }, (_, i) => ({
      name: `d${i}.png`,
      created_at: i === 4 ? FRESH : OLD,
    }));
    const uploads = [{ name: "u0", created_at: OLD }];
    const { db, listCalls, removed } = fakeClient(
      { drafts, uploads },
      ["drafts/d1.png"], // still pointed at by a live draft
    );

    const out = await purgeExpiredDrafts(NOW, { db, pageSize: 2 });

    expect(listCalls).toEqual([
      { folder: "drafts", offset: 0, limit: 2 },
      { folder: "drafts", offset: 2, limit: 2 },
      { folder: "drafts", offset: 4, limit: 2 },
      { folder: "uploads", offset: 0, limit: 2 },
    ]);
    expect(removed.sort()).toEqual([
      "drafts/d0.png",
      "drafts/d2.png",
      "drafts/d3.png",
      "uploads/u0",
    ]);
    expect(out).toEqual({ drafts: 0, objects: 4 });
  });

  it("asks for one more page when the last one was exactly full", async () => {
    const drafts = Array.from({ length: 4 }, (_, i) => ({ name: `d${i}.png`, created_at: OLD }));
    const { db, listCalls, removed } = fakeClient({ drafts }, []);
    await purgeExpiredDrafts(NOW, { db, pageSize: 2 });
    expect(listCalls.filter((c) => c.folder === "drafts").map((c) => c.offset)).toEqual([0, 2, 4]);
    expect(removed).toHaveLength(4);
  });
});
