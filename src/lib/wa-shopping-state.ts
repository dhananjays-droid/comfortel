import { z } from "zod";

/** Customer preferences, never authoritative product facts or action status. */
export const ShoppingMemory = z
  .object({
    category: z.string().trim().max(100).nullable().optional(),
    finish: z.string().trim().max(100).nullable().optional(),
    maxUnitPrice: z.number().finite().nonnegative().max(1000000).nullable().optional(),
    quantity: z.number().int().min(1).max(99).nullable().optional(),
    goal: z.enum(["browse", "quote"]).nullable().optional(),
  })
  .strict();
export type ShoppingMemory = z.infer<typeof ShoppingMemory>;
export function sanitizeShoppingMemory(input: unknown): ShoppingMemory {
  const result = ShoppingMemory.safeParse(input);
  return result.success ? result.data : {};
}
