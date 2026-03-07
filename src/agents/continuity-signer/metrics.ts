import type { MetricMap, Policy, PreSignIntent, Rule } from "./types.js";

export const DERIVED_METRICS = new Set<string>([
  "amount_usd",
  "expected_loss_ceiling_usd",
  "policy_expected_loss_ceiling_usd",
  "manual_review_threshold_usd",
  "single_action_max_usd",
  "budget_type_matches",
  "policy_id_matches",
  "policy_version_matches",
  "policy_hash_matches",
]);

export const RUNTIME_METRICS = new Set<string>(["continuity_burn_24h_usd"]);

export const SUPPORTED_METRICS = new Set<string>([...DERIVED_METRICS, ...RUNTIME_METRICS]);

export function buildPreSignMetrics(
  policy: Policy,
  intent: PreSignIntent,
  extra: MetricMap = {},
): MetricMap {
  return {
    amount_usd: intent.amount_usd,
    expected_loss_ceiling_usd: intent.expected_loss_ceiling_usd,
    policy_expected_loss_ceiling_usd: policy.limits.expected_loss_ceiling_usd,
    manual_review_threshold_usd: policy.limits.manual_review_threshold_usd,
    single_action_max_usd: policy.limits.single_action_max_usd,
    budget_type_matches: intent.budget_type === policy.policy_type,
    policy_id_matches: intent.policy_id === policy.policy_id,
    policy_version_matches: intent.policy_version_locked === policy.policy_version,
    policy_hash_matches: intent.policy_hash === policy.policy_hash,
    ...extra,
  };
}

export function collectRuleMetrics(policy: Policy): Set<string> {
  const metrics = new Set<string>();

  const scanRules = (rules: Rule[]) => {
    for (const rule of rules) {
      for (const condition of rule.if.conditions) {
        if (condition.metric) {
          metrics.add(condition.metric);
        }
        if (condition.metric_ref) {
          metrics.add(condition.metric_ref);
        }
      }
    }
  };

  scanRules(policy.pre_sign_reject_rules);
  scanRules(policy.pre_sign_manual_review_rules);
  scanRules(policy.freeze_rules);

  return metrics;
}

export function lintPolicyMetricCoverage(policy: Policy): void {
  const unknown = [...collectRuleMetrics(policy)]
    .filter((metric) => !SUPPORTED_METRICS.has(metric))
    .toSorted();

  if (unknown.length > 0) {
    throw new Error(`unknown policy metric: ${unknown.join(",")}`);
  }
}
