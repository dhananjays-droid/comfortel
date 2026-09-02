import { afterEach, describe, expect, it } from "vitest";

import { decryptPhone, encryptPhone } from "@/lib/wa-phone-crypto.server";

const ORIGINAL = process.env["WHATSAPP_PHONE_ENC_KEY"];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env["WHATSAPP_PHONE_ENC_KEY"];
  else process.env["WHATSAPP_PHONE_ENC_KEY"] = ORIGINAL;
});

describe("encryptPhone / decryptPhone", () => {
  it("round-trips a phone number", () => {
    process.env["WHATSAPP_PHONE_ENC_KEY"] = "test-key";
    const phone = "15551234567";
    expect(decryptPhone(encryptPhone(phone))).toBe(phone);
  });

  it("never stores the phone number as plaintext in the ciphertext", () => {
    process.env["WHATSAPP_PHONE_ENC_KEY"] = "test-key";
    const encrypted = encryptPhone("15551234567");
    expect(encrypted).not.toContain("5551234567");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    process.env["WHATSAPP_PHONE_ENC_KEY"] = "test-key";
    const a = encryptPhone("15551234567");
    const b = encryptPhone("15551234567");
    expect(a).not.toBe(b);
  });

  it("throws rather than encrypting with no key configured", () => {
    delete process.env["WHATSAPP_PHONE_ENC_KEY"];
    expect(() => encryptPhone("15551234567")).toThrow();
  });

  it("rejects a payload tampered after encryption", () => {
    process.env["WHATSAPP_PHONE_ENC_KEY"] = "test-key";
    const encrypted = encryptPhone("15551234567");
    const bytes = Buffer.from(encrypted, "base64");
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
    expect(() => decryptPhone(bytes.toString("base64"))).toThrow();
  });
});
