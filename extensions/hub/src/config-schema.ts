import { DmPolicySchema, requireOpenAllowFrom } from "openclaw/plugin-sdk";
import { z } from "zod";

export const HubAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    url: z.string().optional(),
    agentId: z.string().optional(),
    secret: z.string().optional(),
    secretFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    defaultTo: z.string().optional(),
    pollTimeoutSec: z.number().int().min(1).max(300).optional(),
  })
  .strict();

export const HubAccountSchema = HubAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.hub.dmPolicy="open" requires channels.hub.allowFrom to include "*"',
  });
});

export const HubConfigSchema = HubAccountSchemaBase.extend({
  accounts: z.record(z.string(), HubAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.hub.dmPolicy="open" requires channels.hub.allowFrom to include "*"',
  });
});
