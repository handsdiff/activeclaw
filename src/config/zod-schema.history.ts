import { z } from "zod";
import { isValidNonNegativeByteSizeString } from "./byte-size.js";

export const HistoryDispositionSchema = z.union([
  z.literal("processed"),
  z.literal("paired_prompted"),
  z.literal("blocked_dm_policy"),
  z.literal("blocked_group_policy"),
  z.literal("blocked_no_mention"),
  z.literal("blocked_command_auth"),
  z.literal("dropped_duplicate"),
  z.literal("dropped_other"),
]);

export const HistorySchema = z
  .object({
    enabled: z.boolean().optional(),
    path: z.string().optional(),
    channel: z
      .object({
        enabled: z.boolean().optional(),
        surfaces: z.array(z.string()).optional(),
        includeQuotedContext: z.boolean().optional(),
        includeNonDispatchedInbound: z.boolean().optional(),
      })
      .strict()
      .optional(),
    cron: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
    shard: z
      .object({
        maxBytes: z
          .union([
            z.number().int().positive(),
            z
              .string()
              .refine(isValidNonNegativeByteSizeString, "Expected byte size string like 128kb"),
          ])
          .optional(),
        padWidth: z.number().int().min(1).max(12).optional(),
      })
      .strict()
      .optional(),
    retention: z
      .object({
        days: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    exclude: z
      .object({
        conversations: z.array(z.string()).optional(),
        jobs: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
