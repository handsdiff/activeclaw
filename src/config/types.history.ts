export type AgentHistoryDisposition =
  | "processed"
  | "paired_prompted"
  | "blocked_dm_policy"
  | "blocked_group_policy"
  | "blocked_no_mention"
  | "blocked_command_auth"
  | "dropped_duplicate"
  | "dropped_other";

export type AgentHistoryConfig = {
  /** Enable durable history capture for this agent (default: false). */
  enabled?: boolean;
  /**
   * Durable history root. Supports `~` and `{agentId}` expansion.
   * Stage 1 requires the resolved path to stay under the agent state root.
   */
  path?: string;
  channel?: {
    /** Enable durable channel-history capture (default: true when history is enabled). */
    enabled?: boolean;
    /** Limit capture to specific surfaces/providers. */
    surfaces?: ReadonlyArray<string>;
    /** Persist quoted or reply-context snapshots when available. */
    includeQuotedContext?: boolean;
    /** Persist blocked/pairing/non-dispatched inbound attempts. */
    includeNonDispatchedInbound?: boolean;
  };
  cron?: {
    /** Enable durable cron history capture (default: true when history is enabled). */
    enabled?: boolean;
  };
  shard?: {
    /** Maximum shard size before rolling to the next sequence file. */
    maxBytes?: number | string;
    /** Zero-padding width for sequence file names (default: 4). */
    padWidth?: number;
  };
  retention?: {
    /** Optional retention window in days for history shards. */
    days?: number;
  };
  exclude?: {
    /** Conversation keys to skip for durable history. */
    conversations?: ReadonlyArray<string>;
    /** Cron job ids to skip for durable history. */
    jobs?: ReadonlyArray<string>;
  };
};
