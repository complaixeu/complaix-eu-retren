import { describe, expect, it, vi } from "vitest";
import { sendTicket } from "@/app/(intake)/reclamar/foto/ticket-choice";
import {
  UPLOAD_PREFIX,
  checkStoredTicket,
  declaredTicketError,
  uploadContentType,
  type StoredObjects,
} from "@/features/intake/upload/direct";
import { TICKET_MAX_BYTES, TICKET_UPLOAD_ERRORS } from "@/features/intake/upload/rules";
import {
  PLACEHOLDER_HEIC,
  PLACEHOLDER_JPEG,
  PLACEHOLDER_PDF,
  PLACEHOLDER_PNG,
  PLACEHOLDER_TEXT,
} from "@/tests/fixtures/intake/tickets";

// [A1 follow-up] Direct upload: the browser puts the file straight into Storage, then the server
// checks the stored object (size, then type by its first bytes) and deletes it when it fails.

/** Objects in memory, recording what was read and removed. */
function memoryObjects(files: Record<string, Uint8Array | { size: number }>) {
  const reads: string[] = [];
  const removed: string[] = [];
  const objects: StoredObjects = {
    size: async (path) => {
      const f = files[path];
      if (!f) return null;
      return f instanceof Uint8Array ? f.byteLength : f.size;
    },
    read: async (path) => {
      reads.push(path);
      const f = files[path];
      return f instanceof Uint8Array ? f : null;
    },
    remove: async (path) => {
      removed.push(path);
      delete files[path];
    },
  };
  return { objects, reads, removed };
}

const staged = `${UPLOAD_PREFIX}6f1c2a1e-6d9b-4d0e-9a51-6f0b8f1b2c3d`;

describe("checkStoredTicket (the server check after a direct upload)", () => {
  it.each([
    ["png", PLACEHOLDER_PNG],
    ["jpeg", PLACEHOLDER_JPEG],
    ["pdf", PLACEHOLDER_PDF],
    ["heic", PLACEHOLDER_HEIC],
  ] as const)("accepts a stored %s and keeps it", async (type, bytes) => {
    const { objects, removed } = memoryObjects({ [staged]: bytes });
    // The bytes come back, so the server re-uploads them under the detected content type.
    expect(await checkStoredTicket(staged, objects)).toEqual({
      ok: true,
      type,
      size: bytes.byteLength,
      bytes,
    });
    expect(removed).toEqual([]);
  });

  it("refuses wrong magic bytes in Storage, whatever the file claimed, and deletes it", async () => {
    const { objects, removed } = memoryObjects({ [staged]: PLACEHOLDER_TEXT });
    expect(await checkStoredTicket(staged, objects)).toEqual({ ok: false, error: "wrong_type" });
    expect(removed).toEqual([staged]);
  });

  it("refuses an object over 10 MB without reading it, and deletes it", async () => {
    const { objects, reads, removed } = memoryObjects({
      [staged]: { size: TICKET_MAX_BYTES + 1 },
    });
    expect(await checkStoredTicket(staged, objects)).toEqual({ ok: false, error: "too_large" });
    expect(reads).toEqual([]);
    expect(removed).toEqual([staged]);
  });

  it("refuses an empty object and deletes it", async () => {
    const { objects, removed } = memoryObjects({ [staged]: new Uint8Array() });
    expect(await checkStoredTicket(staged, objects)).toEqual({ ok: false, error: "empty" });
    expect(removed).toEqual([staged]);
  });

  it("reports a missing object as not received", async () => {
    const { objects, removed } = memoryObjects({});
    expect(await checkStoredTicket(staged, objects)).toEqual({
      ok: false,
      error: "not_received",
    });
    expect(removed).toEqual([]);
  });

  it("only checks objects in the upload area", async () => {
    const { objects } = memoryObjects({ "drafts/x.png": PLACEHOLDER_PNG });
    expect(await checkStoredTicket("drafts/x.png", objects)).toEqual({
      ok: false,
      error: "not_received",
    });
  });
});

describe("before the upload: what the browser declares", () => {
  it("maps the chosen file to the content type it is uploaded with", () => {
    expect(uploadContentType({ name: "a.JPG", type: "" })).toBe("image/jpeg");
    expect(uploadContentType({ name: "a.jpeg", type: "image/jpeg" })).toBe("image/jpeg");
    expect(uploadContentType({ name: "a.png", type: "" })).toBe("image/png");
    expect(uploadContentType({ name: "IMG_1.HEIC", type: "" })).toBe("image/heic");
    expect(uploadContentType({ name: "IMG_1.heif", type: "image/heif" })).toBe("image/heic");
    expect(uploadContentType({ name: "b.pdf", type: "application/pdf" })).toBe("application/pdf");
    expect(uploadContentType({ name: "foto", type: "image/png" })).toBe("image/png");
    expect(uploadContentType({ name: "notas.txt", type: "text/plain" })).toBeNull();
  });

  it("refuses a declared size or type the check would refuse anyway", () => {
    expect(declaredTicketError({ name: "a.png", type: "image/png", size: 10 })).toBeNull();
    expect(declaredTicketError({ name: "a.png", type: "", size: TICKET_MAX_BYTES + 1 })).toBe(
      "too_large",
    );
    expect(declaredTicketError({ name: "a.png", type: "", size: 0 })).toBe("empty");
    expect(declaredTicketError({ name: "a.txt", type: "text/plain", size: 10 })).toBe("wrong_type");
  });

  it("has a message for a file that never arrived", () => {
    expect(TICKET_UPLOAD_ERRORS.not_received).toMatch(/Vuelve a/);
  });
});

describe("sendTicket (the browser side of the direct upload)", () => {
  const file = new File([Buffer.from(PLACEHOLDER_PNG)], "billete.png", { type: "image/png" });
  const ready = {
    status: "ready" as const,
    uploadUrl: "http://127.0.0.1:54321/storage/v1/object/upload/sign/tickets/uploads/x?token=t",
    contentType: "image/png",
  };
  const ok = { status: "ok" as const, key: "0123456789abcdef" };

  it("begins, PUTs the file to the signed URL with the agreed type, then finishes", async () => {
    const begin = vi.fn(async () => ready);
    const finish = vi.fn(async () => ok);
    const put = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
    expect(await sendTicket(file, { begin, finish, put })).toEqual(ok);
    expect(begin).toHaveBeenCalledWith({ name: "billete.png", type: "image/png", size: file.size });
    expect(put).toHaveBeenCalledWith(ready.uploadUrl, {
      method: "PUT",
      headers: { "content-type": "image/png", "x-upsert": "false" },
      body: file,
    });
    expect(finish).toHaveBeenCalledOnce();
  });

  it("reports which upload stage is active", async () => {
    const stages: string[] = [];
    await sendTicket(
      file,
      {
        begin: async () => ready,
        finish: async () => ok,
        put: async () => new Response("{}", { status: 200 }),
      },
      { onStage: (stage) => stages.push(stage) },
    );
    expect(stages).toEqual(["preparing", "uploading", "checking"]);
  });

  it("stops at a refused begin, without uploading", async () => {
    const put = vi.fn<typeof fetch>();
    const out = await sendTicket(file, {
      begin: async () => ({ status: "error", error: "wrong_type" }),
      finish: async () => ok,
      put,
    });
    expect(out).toEqual({ status: "error", error: "wrong_type" });
    expect(put).not.toHaveBeenCalled();
  });

  it("maps a size refusal from Storage to too_large, and a lost upload to not_received", async () => {
    const finish = vi.fn(async () => ok);
    const begin = async () => ready;
    const tooLarge = await sendTicket(file, {
      begin,
      finish,
      put: async () => new Response(JSON.stringify({ statusCode: "413" }), { status: 400 }),
    });
    expect(tooLarge).toEqual({ status: "error", error: "too_large" });
    const lost = await sendTicket(file, {
      begin,
      finish,
      put: async () => {
        throw new TypeError("network");
      },
    });
    expect(lost).toEqual({ status: "error", error: "not_received" });
    expect(finish).not.toHaveBeenCalled();
  });

  it("lets a server action that throws reach the step's error page", async () => {
    // Expected failures come back as { status: "error" }; a throw is the platform or a bug.
    await expect(
      sendTicket(file, {
        begin: async () => {
          throw new Error("413");
        },
        finish: async () => ok,
      }),
    ).rejects.toThrow("413");
  });
});
