import { hashIntent } from "./evaluator.js";
import type { Policy, PostExecutionReceipt, PreSignIntent } from "./types.js";
import { CONTINUITY_SIGNER_SCHEMA_VERSION } from "./types.js";

export const continuityNewPolicyFixture: Policy = {
  schema_version: CONTINUITY_SIGNER_SCHEMA_VERSION,
  policy_id: "continuity_new_v1",
  policy_version: CONTINUITY_SIGNER_SCHEMA_VERSION,
  policy_hash: "policy_hash_v1",
  policy_type: "continuity_budget",
  trust_tier: "new",
  limits: {
    monthly_cap_usd: 500,
    manual_review_threshold_usd: 80,
    single_action_max_usd: 100,
    expected_loss_ceiling_usd: 40,
  },
  pre_sign_reject_rules: [
    {
      id: "reject_binding",
      if: {
        mode: "any",
        conditions: [
          { metric: "budget_type_matches", op: "==", value: false },
          { metric: "policy_id_matches", op: "==", value: false },
          { metric: "policy_version_matches", op: "==", value: false },
          { metric: "policy_hash_matches", op: "==", value: false },
        ],
      },
      outcome: { decision: "reject", reason_codes: ["policy_binding_failed"] },
    },
    {
      id: "reject_loss_ceiling",
      if: {
        mode: "all",
        conditions: [
          {
            metric: "expected_loss_ceiling_usd",
            op: ">",
            metric_ref: "policy_expected_loss_ceiling_usd",
          },
        ],
      },
      outcome: { decision: "reject", reason_codes: ["expected_loss_ceiling_exceeded"] },
    },
    {
      id: "reject_single_action_max",
      if: {
        mode: "all",
        conditions: [{ metric: "amount_usd", op: ">", metric_ref: "single_action_max_usd" }],
      },
      outcome: { decision: "reject", reason_codes: ["single_action_max_exceeded"] },
    },
  ],
  pre_sign_manual_review_rules: [
    {
      id: "manual_review_band",
      if: {
        mode: "all",
        conditions: [
          { metric: "amount_usd", op: ">", metric_ref: "manual_review_threshold_usd" },
          { metric: "amount_usd", op: "<=", metric_ref: "single_action_max_usd" },
        ],
      },
      outcome: { decision: "manual_review", reason_codes: ["manual_threshold_exceeded"] },
    },
  ],
  freeze_rules: [
    {
      id: "freeze_daily_burn",
      if: {
        mode: "all",
        conditions: [{ metric: "continuity_burn_24h_usd", op: ">=", value: 40 }],
      },
      outcome: {
        decision: "freeze",
        reason_codes: ["daily_burn_limit_breached"],
        freeze_scope: "continuity_only",
        freeze_actions: ["disable_autosign", "notify_operator", "require_manual_review"],
        unfreeze_requirements: ["next_utc_day_rollover", "operator_approval_recorded"],
      },
    },
  ],
};

export function makePreSignIntent(overrides: Partial<PreSignIntent> = {}): PreSignIntent {
  const base: PreSignIntent = {
    schema_version: CONTINUITY_SIGNER_SCHEMA_VERSION,
    intent_id: "intent_cont_001",
    timestamp_utc: "2026-03-07T05:00:00Z",
    wallet_id: "ops_hot_01",
    budget_type: "continuity_budget",
    spend_class: "rpc_service",
    counterparty_or_protocol: "vendor:alchemy",
    amount_usd: 50,
    expected_value_driver: "uptime",
    expected_value_range_usd: { min: 20, max: 200 },
    expected_loss_ceiling_usd: 20,
    outcome_window_hours: 168,
    policy_id: continuityNewPolicyFixture.policy_id,
    policy_version_locked: continuityNewPolicyFixture.policy_version,
    policy_hash: continuityNewPolicyFixture.policy_hash,
    intent_hash: "",
  };

  const intent = {
    ...base,
    ...overrides,
  } satisfies PreSignIntent;

  return {
    ...intent,
    intent_hash: hashIntent({ ...intent, intent_hash: "" }),
  };
}

export function makeReceiptFromIntent(
  intent: PreSignIntent,
  overrides: Partial<PostExecutionReceipt> = {},
): PostExecutionReceipt {
  return {
    schema_version: CONTINUITY_SIGNER_SCHEMA_VERSION,
    receipt_id: "receipt_cont_001",
    receipt_status: "complete",
    intent_id: intent.intent_id,
    intent_hash: intent.intent_hash,
    policy_id: intent.policy_id,
    policy_version_locked: intent.policy_version_locked,
    policy_hash: intent.policy_hash,
    budget_type: intent.budget_type,
    spend_class: intent.spend_class,
    wallet_id: intent.wallet_id,
    counterparty_or_protocol: intent.counterparty_or_protocol,
    amount_usd: intent.amount_usd,
    ...overrides,
  };
}
