export const CONTINUITY_SIGNER_SCHEMA_VERSION = "1.0.0" as const;

export type PolicyType = "performance_budget" | "continuity_budget";
export type TrustTier = "new" | "calibrated" | "proven";
export type Decision = "allow" | "manual_review" | "reject" | "freeze";
export type FreezeScope = "performance_only" | "continuity_only" | "wallet_global";
export type FreezeAction = "disable_autosign" | "require_manual_review" | "notify_operator";
export type LogicMode = "all" | "any";
export type Op = ">" | ">=" | "<" | "<=" | "==" | "!=" | "in" | "not_in";

export type MetricMap = Record<string, number | string | boolean | string[] | undefined>;

export type Condition = {
  metric: string;
  op: Op;
  value?: number | string | boolean | string[];
  metric_ref?: string;
};

export type ConditionGroup = {
  mode: LogicMode;
  conditions: Condition[];
};

export type RuleOutcome = {
  decision: Decision;
  reason_codes: string[];
  freeze_scope?: FreezeScope;
  freeze_actions?: FreezeAction[];
  unfreeze_requirements?: string[];
};

export type Rule = {
  id: string;
  if: ConditionGroup;
  outcome: RuleOutcome;
};

export type Policy = {
  schema_version: typeof CONTINUITY_SIGNER_SCHEMA_VERSION;
  policy_id: string;
  policy_version: typeof CONTINUITY_SIGNER_SCHEMA_VERSION;
  policy_hash: string;
  policy_type: PolicyType;
  trust_tier: TrustTier;
  limits: {
    monthly_cap_usd: number;
    manual_review_threshold_usd: number;
    single_action_max_usd: number;
    expected_loss_ceiling_usd: number;
  };
  pre_sign_reject_rules: Rule[];
  pre_sign_manual_review_rules: Rule[];
  freeze_rules: Rule[];
};

export type PreSignIntent = {
  schema_version: typeof CONTINUITY_SIGNER_SCHEMA_VERSION;
  intent_id: string;
  timestamp_utc: string;
  wallet_id: string;
  budget_type: PolicyType;
  spend_class: string;
  counterparty_or_protocol: string;
  amount_usd: number;
  expected_value_driver: string;
  expected_value_range_usd: { min: number; max: number };
  expected_loss_ceiling_usd: number;
  outcome_window_hours: number;
  policy_id: string;
  policy_version_locked: typeof CONTINUITY_SIGNER_SCHEMA_VERSION;
  policy_hash: string;
  intent_hash: string;
  signed_at_utc?: string;
};

export type PostExecutionReceipt = {
  schema_version: typeof CONTINUITY_SIGNER_SCHEMA_VERSION;
  receipt_id: string;
  receipt_status: "pending_outcome" | "complete" | "noncompliant";
  intent_id: string;
  intent_hash: string;
  policy_id: string;
  policy_version_locked: typeof CONTINUITY_SIGNER_SCHEMA_VERSION;
  policy_hash: string;
  signed_at_utc?: string;
  budget_type: PolicyType;
  spend_class: string;
  wallet_id: string;
  counterparty_or_protocol: string;
  amount_usd: number;
};

export type EvaluatorResult = {
  decision: Decision;
  reason_codes: string[];
  triggered_rule_ids: string[];
  freeze_scope?: FreezeScope;
  freeze_actions?: FreezeAction[];
  unfreeze_requirements?: string[];
  hit_counts: {
    freeze: number;
    reject: number;
    manual_review: number;
  };
};
