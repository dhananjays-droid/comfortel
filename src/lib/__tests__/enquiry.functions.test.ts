import { describe, expect, it } from "vitest";

import { parseEnquiryInput } from "@/lib/enquiry.functions";

/**
 * Only parseEnquiryInput (pure) is unit-tested here — runSubmitEnquiry hits
 * Supabase and Resend directly, which this test environment has no
 * credentials for, matching this repo's existing convention for
 * network-touching modules.
 */

const base = { productId: "abc", fullName: "Jamie Lee", email: "jamie@lee.com" };

describe("parseEnquiryInput", () => {
  it("requires the basics", () => {
    expect(() => parseEnquiryInput({ ...base, productId: "" })).toThrow();
    expect(() => parseEnquiryInput({ ...base, fullName: "J" })).toThrow("NAME_REQUIRED");
    expect(() => parseEnquiryInput({ ...base, email: "not-an-email" })).toThrow("EMAIL_INVALID");
  });

  it("defaults to no additional emails", () => {
    expect(parseEnquiryInput(base).additionalEmails).toEqual([]);
  });

  it("keeps valid additional emails, distinct from the primary", () => {
    const data = parseEnquiryInput({
      ...base,
      additionalEmails: ["partner@biz.com", "second@biz.com"],
    });
    expect(data.additionalEmails).toEqual(["partner@biz.com", "second@biz.com"]);
  });

  it("drops an additional email that is not a real address", () => {
    const data = parseEnquiryInput({ ...base, additionalEmails: ["not-an-email"] });
    expect(data.additionalEmails).toEqual([]);
  });

  it("drops a duplicate of the primary email", () => {
    const data = parseEnquiryInput({ ...base, additionalEmails: ["jamie@lee.com"] });
    expect(data.additionalEmails).toEqual([]);
  });

  it("dedupes repeated additional emails", () => {
    const data = parseEnquiryInput({
      ...base,
      additionalEmails: ["partner@biz.com", "partner@biz.com"],
    });
    expect(data.additionalEmails).toEqual(["partner@biz.com"]);
  });

  it("caps additional emails at 4", () => {
    const data = parseEnquiryInput({
      ...base,
      additionalEmails: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"],
    });
    expect(data.additionalEmails).toHaveLength(4);
  });

  it("ignores a non-array additionalEmails rather than throwing", () => {
    expect(
      parseEnquiryInput({ ...base, additionalEmails: "jamie@lee.com" as unknown as string[] })
        .additionalEmails,
    ).toEqual([]);
  });
});
