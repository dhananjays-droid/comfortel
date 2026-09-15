import { z } from "zod";

export const Requirement = z
  .object({
    category: z.string().trim().min(1).max(80),
    quantity: z.number().int().min(1).max(99).nullable().optional(),
    finish: z.string().trim().max(80).nullable().optional(),
    maxUnitPrice: z.number().finite().nonnegative().max(1000000).nullable().optional(),
  })
  .strict();

export const ConversationMemory = z
  .object({
    version: z.literal(1).default(1),
    activeTask: z.enum(["browse", "plan", "request", "render"]).default("browse"),
    suspendedTask: z.enum(["browse", "plan", "request", "render"]).nullable().default(null),
    stations: z.number().int().min(1).max(20).nullable().default(null),
    budget: z.number().finite().positive().max(1000000).nullable().default(null),
    currency: z.enum(["USD", "AUD", "CAD", "GBP", "EUR", "other"]).nullable().default(null),
    budgetScope: z.enum(["equipment", "whole_project"]).nullable().default(null),
    pendingQuestion: z.string().max(300).nullable().default(null),
    requirements: z.array(Requirement).max(10).default([]),
    shortlistVersion: z.string().max(50).nullable().default(null),
  })
  .strict();
export type ConversationMemory = z.infer<typeof ConversationMemory>;
export function conversationMemory(value: unknown): ConversationMemory {
  const parsed = ConversationMemory.safeParse(value ?? {});
  return parsed.success ? parsed.data : ConversationMemory.parse({});
}

// Task-specific quantities stay in the plan; project station count never
// becomes a global product quantity. No catalog facts are stored in memory.
export const ConversationPatch = ConversationMemory.omit({
  version: true,
  shortlistVersion: true,
}).partial();
