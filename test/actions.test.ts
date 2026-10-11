import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { actionDigest, decodeAction, encodeAction, newActionId, toFieldText, validateAction, verifyActionSignature } from "../src/actions.js";
import { normalizeHandle, parseTag } from "../src/handles.js";
import type { Action } from "../src/types.js";

const pay: Action = {
  code: "PAY",
  id: "00112233445566778899aabbccddeeff",
  fields: [
    { label: "To", value: "@gabriel" },
    { label: "Amount", value: "$5.00" },
    { label: "Memo", value: "lunch" },
  ],
};

describe("action encoding", () => {
  it("encodes the documented layout", () => {
    const bytes = encodeAction(pay);
    expect(bytes.subarray(0, 4).toString()).toBe("AGS1");
    expect(bytes.subarray(4, 7).toString()).toBe("PAY");
    expect(bytes.subarray(7, 23).toString("hex")).toBe(pay.id);
    expect(bytes[23]).toBe(3);
    expect(bytes.subarray(24).toString("latin1")).toBe("\x02To\x08@gabriel\x06Amount\x05$5.00\x04Memo\x05lunch");
  });

  it("round-trips", () => {
    expect(decodeAction(encodeAction(pay))).toEqual(pay);
  });

  it("rejects what a device cannot show", () => {
    expect(() => validateAction({ ...pay, fields: [] })).toThrow(/1 to 6 fields/);
    expect(() => validateAction({ ...pay, fields: [{ label: "To", value: "café" }] })).toThrow(/printable ASCII/);
    expect(() => validateAction({ ...pay, fields: [{ label: "A".repeat(17), value: "x" }] })).toThrow(/longer than 16/);
    expect(() => validateAction({ ...pay, id: "nope" })).toThrow(/32 lowercase hex/);
    expect(() => decodeAction(Buffer.from("AGS1PAY"))).toThrow(/truncated/);
  });

  it("sanitizes free text into a field", () => {
    expect(toFieldText("  Dinner at café — Gabe’s  ")).toBe("Dinner at cafe - Gabe's");
    expect(toFieldText("x".repeat(100))).toHaveLength(64);
    expect(toFieldText("\u{1F600}")).toBe("-");
  });

  it("verifies an Ed25519 signature over sha256 of the encoding", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubkeyHex = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");
    const signature = sign(null, actionDigest(pay), privateKey).toString("hex");
    expect(verifyActionSignature(pubkeyHex, pay, signature)).toBe(true);
    expect(verifyActionSignature(pubkeyHex, { ...pay, id: newActionId() }, signature)).toBe(false);
    expect(verifyActionSignature(pubkeyHex, pay, signature.replace(/^../, "00"))).toBe(false);
    expect(verifyActionSignature(pubkeyHex, pay, "zz")).toBe(false);
  });
});

describe("handles and tags", () => {
  it("normalizes phone numbers and emails", () => {
    expect(normalizeHandle("+1 (415) 555-1234")).toBe("+14155551234");
    expect(normalizeHandle("415-555-1234")).toBe("+14155551234");
    expect(normalizeHandle(" Matt@Example.COM ")).toBe("matt@example.com");
  });
  it("parses tags", () => {
    expect(parseTag("@Gabriel")).toBe("@gabriel");
    expect(parseTag("yadu")).toBe("@yadu");
    expect(parseTag("@a")).toBeUndefined();
    expect(parseTag("hello there")).toBeUndefined();
  });
});

describe("telegram handles", () => {
  it("keeps tg ids as they are", () => {
    expect(normalizeHandle(" TG:123456 ")).toBe("tg:123456");
  });
});
