import crypto from "node:crypto";
import { buildPreSignMetrics } from "./metrics.js";
import {
  CONTINUITY_SIGNER_SCHEMA_VERSION,
  type Condition,
  type ConditionGroup,
  type Decision,
  type EvaluatorResult,
  type FreezeScope,
  type MetricMap,
  type Policy,
  type PostExecutionReceipt,
  type PreSignIntent,
  type Rule,
} from "./types.js";

export function deepSortObject<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map((item) => deepSortObject(item)) as T;
  }

  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).toSorted()) {
      out[key] = deepSortObject((obj as Record<string, unknown>)[key]);
    }
    return out as T;
  }

  return obj;
}

export function canonicalizeIntent(intent: PreSignIntent): Record<string, unknown> {
  const canonical: Record<string, unknown> = {
    schema_version: intent.schema_version,
    intent_id: intent.intent_id,
    timestamp_utc: intent.timestamp_utc,
    wallet_id: intent.wallet_id,
    budget_type: intent.budget_type,
    spend_class: intent.spend_class,
    counterparty_or_protocol: intent.counterparty_or_protocol,
    amount_usd: intent.amount_usd,
    expected_value_driver: intent.expected_value_driver,
    expected_value_range_usd: intent.expected_value_range_usd,
    expected_loss_ceiling_usd: intent.expected_loss_ceiling_usd,
    outcome_window_hours: intent.outcome_window_hours,
    policy_id: intent.policy_id,
    policy_version_locked: intent.policy_version_locked,
    policy_hash: intent.policy_hash,
  };

  if (intent.signed_at_utc) {
    canonical.signed_at_utc = intent.signed_at_utc;
  }

  return deepSortObject(canonical);
}

export function hashIntent(intent: PreSignIntent): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalizeIntent(intent)))
    .digest("hex");
}

export function verifyIntentHash(intent: PreSignIntent): { ok: boolean; reason?: string } {
  if (intent.schema_version !== CONTINUITY_SIGNER_SCHEMA_VERSION) {
    return { ok: false, reason: "intent_schema_version_invalid" };
  }

  if (!intent.intent_hash) {
    return { ok: false, reason: "intent_hash_missing" };
  }

  if (!intent.policy_hash) {
    return { ok: false, reason: "intent_policy_hash_missing" };
  }

  return hashIntent(intent) === intent.intent_hash
    ? { ok: true }
    : { ok: false, reason: "intent_hash_mismatch" };
}

export function verifyReceiptBinding(
  receipt: PostExecutionReceipt,
  approvedIntent: PreSignIntent,
  policy: Policy,
): { ok: boolean; reason?: string } {
  if (receipt.schema_version !== CONTINUITY_SIGNER_SCHEMA_VERSION) {
    return { ok: false, reason: "receipt_schema_version_invalid" };
  }
  if (approvedIntent.schema_version !== CONTINUITY_SIGNER_SCHEMA_VERSION) {
    return { ok: false, reason: "intent_schema_version_invalid" };
  }
  if (policy.schema_version !== CONTINUITY_SIGNER_SCHEMA_VERSION) {
    return { ok: false, reason: "policy_schema_version_invalid" };
  }

  if (!policy.policy_hash) {
    return { ok: false, reason: "policy_hash_missing" };
  }
  if (!approvedIntent.policy_hash) {
    return { ok: false, reason: "intent_policy_hash_missing" };
  }
  if (!receipt.policy_hash) {
    return { ok: false, reason: "receipt_policy_hash_missing" };
  }
  if (!approvedIntent.intent_hash) {
    return { ok: false, reason: "intent_hash_missing" };
  }
  if (!receipt.intent_hash) {
    return { ok: false, reason: "receipt_intent_hash_missing" };
  }

  const hashCheck = verifyIntentHash(approvedIntent);
  if (!hashCheck.ok) {
    return hashCheck;
  }

  if (approvedIntent.policy_id !== policy.policy_id) {
    return { ok: false, reason: "intent_policy_id_mismatch" };
  }
  if (approvedIntent.policy_version_locked !== policy.policy_version) {
    return { ok: false, reason: "intent_policy_version_mismatch" };
  }
  if (approvedIntent.policy_hash !== policy.policy_hash) {
    return { ok: false, reason: "intent_policy_hash_mismatch" };
  }

  if (receipt.intent_id !== approvedIntent.intent_id) {
    return { ok: false, reason: "receipt_intent_id_mismatch" };
  }
  if (receipt.intent_hash !== approvedIntent.intent_hash) {
    return { ok: false, reason: "receipt_intent_hash_mismatch" };
  }
  if (receipt.policy_id !== policy.policy_id) {
    return { ok: false, reason: "receipt_policy_id_mismatch" };
  }
  if (receipt.policy_version_locked !== policy.policy_version) {
    return { ok: false, reason: "receipt_policy_version_mismatch" };
  }
  if (receipt.policy_hash !== policy.policy_hash) {
    return { ok: false, reason: "receipt_policy_hash_mismatch" };
  }

  if (receipt.budget_type !== approvedIntent.budget_type) {
    return { ok: false, reason: "receipt_budget_type_mismatch" };
  }
  if (receipt.wallet_id !== approvedIntent.wallet_id) {
    return { ok: false, reason: "receipt_wallet_id_mismatch" };
  }
  if (receipt.spend_class !== approvedIntent.spend_class) {
    return { ok: false, reason: "receipt_spend_class_mismatch" };
  }
  if (receipt.counterparty_or_protocol !== approvedIntent.counterparty_or_protocol) {
    return { ok: false, reason: "receipt_counterparty_or_protocol_mismatch" };
  }
  if (Number(receipt.amount_usd) !== Number(approvedIntent.amount_usd)) {
    return { ok: false, reason: "receipt_amount_usd_mismatch" };
  }

  return { ok: true };
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function mkReject(reason: string, ruleId: string): EvaluatorResult {
  return {
    decision: "reject",
    reason_codes: [reason],
    triggered_rule_ids: [ruleId],
    hit_counts: { freeze: 0, reject: 1, manual_review: 0 },
  };
}

function cmp(left: unknown, op: Condition["op"], right: unknown): boolean {
  if (op === "in" || op === "not_in") {
    const values = Array.isArray(right) ? right : [];
    const has = values.includes(left as never);
    return op === "in" ? has : !has;
  }

  if (op === ">" || op === ">=" || op === "<" || op === "<=") {
    const l = Number(left);
    const r = Number(right);
    if (Number.isNaN(l) || Number.isNaN(r)) {
      return false;
    }
    if (op === ">") {
      return l > r;
    }
    if (op === ">=") {
      return l >= r;
    }
    if (op === "<") {
      return l < r;
    }
    return l <= r;
  }

  if (op === "==") {
    return left === right;
  }

  return left !== right;
}

function evalCondition(condition: Condition, metrics: MetricMap): boolean {
  const left = metrics[condition.metric];
  const right = condition.metric_ref ? metrics[condition.metric_ref] : condition.value;
  if (left === undefined || right === undefined) {
    return false;
  }
  return cmp(left, condition.op, right);
}

function evalGroup(group: ConditionGroup, metrics: MetricMap): boolean {
  return group.mode === "all"
    ? group.conditions.every((condition) => evalCondition(condition, metrics))
    : group.conditions.some((condition) => evalCondition(condition, metrics));
}

function matchingRules(rules: Rule[], metrics: MetricMap): Rule[] {
  return rules.filter((rule) => evalGroup(rule.if, metrics));
}

function mergeFreeze(hits: Rule[]): {
  freeze_scope?: FreezeScope;
  freeze_actions?: Rule["outcome"]["freeze_actions"];
  unfreeze_requirements?: Rule["outcome"]["unfreeze_requirements"];
} {
  const priorities: Record<FreezeScope, number> = {
    performance_only: 1,
    continuity_only: 1,
    wallet_global: 2,
  };

  let scope: FreezeScope | undefined;
  for (const hit of hits) {
    const next = hit.outcome.freeze_scope;
    if (!next) {
      continue;
    }
    if (!scope || priorities[next] > priorities[scope]) {
      scope = next;
    }
  }

  return {
    freeze_scope: scope,
    freeze_actions: uniq(hits.flatMap((hit) => hit.outcome.freeze_actions ?? [])),
    unfreeze_requirements: uniq(hits.flatMap((hit) => hit.outcome.unfreeze_requirements ?? [])),
  };
}

export function evaluatePreSign(
  policy: Policy,
  intent: PreSignIntent,
  extraMetrics: MetricMap = {},
): EvaluatorResult {
  if (policy.schema_version !== CONTINUITY_SIGNER_SCHEMA_VERSION) {
    return mkReject("policy_schema_version_invalid", "schema_guard");
  }
  if (intent.schema_version !== CONTINUITY_SIGNER_SCHEMA_VERSION) {
    return mkReject("intent_schema_version_invalid", "schema_guard");
  }
  if (!policy.policy_hash) {
    return mkReject("policy_hash_missing", "binding_guard");
  }
  if (!intent.policy_hash) {
    return mkReject("intent_policy_hash_missing", "binding_guard");
  }

  const hashCheck = verifyIntentHash(intent);
  if (!hashCheck.ok) {
    return mkReject(hashCheck.reason ?? "intent_hash_invalid", "binding_guard");
  }

  const metrics = buildPreSignMetrics(policy, intent, extraMetrics);
  const rejectHits = matchingRules(policy.pre_sign_reject_rules, metrics);
  const manualHits = matchingRules(policy.pre_sign_manual_review_rules, metrics);

  return {
    decision: rejectHits.length > 0 ? "reject" : manualHits.length > 0 ? "manual_review" : "allow",
    reason_codes:
      rejectHits.length > 0 || manualHits.length > 0
        ? uniq([...rejectHits, ...manualHits].flatMap((rule) => rule.outcome.reason_codes))
        : ["all_pre_sign_checks_passed"],
    triggered_rule_ids: [...rejectHits, ...manualHits].map((rule) => rule.id),
    hit_counts: {
      freeze: 0,
      reject: rejectHits.length,
      manual_review: manualHits.length,
    },
  };
}

export function evaluateFreeze(policy: Policy, metrics: MetricMap): EvaluatorResult {
  if (policy.schema_version !== CONTINUITY_SIGNER_SCHEMA_VERSION) {
    return {
      decision: "freeze",
      reason_codes: ["policy_schema_version_invalid"],
      triggered_rule_ids: ["freeze_schema_guard"],
      freeze_scope: "wallet_global",
      freeze_actions: ["disable_autosign", "require_manual_review", "notify_operator"],
      unfreeze_requirements: ["fix_policy_schema_version", "operator_approval_recorded"],
      hit_counts: { freeze: 1, reject: 0, manual_review: 0 },
    };
  }

  const hits = matchingRules(policy.freeze_rules, metrics);
  if (hits.length === 0) {
    return {
      decision: "allow",
      reason_codes: ["no_freeze_rules_triggered"],
      triggered_rule_ids: [],
      hit_counts: { freeze: 0, reject: 0, manual_review: 0 },
    };
  }

  const merged = mergeFreeze(hits);
  return {
    decision: "freeze",
    reason_codes: uniq(hits.flatMap((rule) => rule.outcome.reason_codes)),
    triggered_rule_ids: hits.map((rule) => rule.id),
    freeze_scope: merged.freeze_scope,
    freeze_actions: merged.freeze_actions,
    unfreeze_requirements: merged.unfreeze_requirements,
    hit_counts: { freeze: hits.length, reject: 0, manual_review: 0 },
  };
}

export function evaluateFinalDecision(
  preSign: EvaluatorResult,
  freeze: EvaluatorResult,
): EvaluatorResult {
  const decision: Decision =
    freeze.decision === "freeze"
      ? "freeze"
      : preSign.decision === "reject"
        ? "reject"
        : preSign.decision === "manual_review"
          ? "manual_review"
          : "allow";

  return {
    decision,
    reason_codes: uniq([...freeze.reason_codes, ...preSign.reason_codes]),
    triggered_rule_ids: uniq([...freeze.triggered_rule_ids, ...preSign.triggered_rule_ids]),
    freeze_scope: freeze.freeze_scope,
    freeze_actions: freeze.freeze_actions,
    unfreeze_requirements: freeze.unfreeze_requirements,
    hit_counts: {
      freeze: freeze.hit_counts.freeze,
      reject: preSign.hit_counts.reject,
      manual_review: preSign.hit_counts.manual_review,
    },
  };
}
