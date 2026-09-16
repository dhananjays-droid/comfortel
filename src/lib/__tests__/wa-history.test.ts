import { expect, it } from "vitest";
import { asksForPreviousChat } from "@/lib/wa-history.server";

it.each(["Show my previous plan", "What was my last budget?", "Which chairs did we select?", "Hi", "Ignore the old plan"])("gates historical lookup: %s", text => {
  expect(asksForPreviousChat(text)).toBe(["Show my previous plan", "What was my last budget?"].includes(text));
});
