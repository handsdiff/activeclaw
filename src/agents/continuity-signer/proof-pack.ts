export const PROOF_PACK_SCHEMA_VERSION = "1.0.0" as const;

export type ContinuityProofCompleteness = {
  logged_risk_event: boolean;
  timestamped_preventive_action: boolean;
  counterfactual_model_present: boolean;
  predeclared_unit_costs_present: boolean;
  post_event_verification_present: boolean;
  all_required_items_present: boolean;
};

export type ContinuityProofPack = {
  proof_pack_schema_version: typeof PROOF_PACK_SCHEMA_VERSION;
  claim_id: string;
  budget_type: "continuity_budget";
  policy_type: "continuity_budget";
  trust_tier: "new" | "calibrated" | "proven";
  claim_window_start_utc: string;
  claim_window_end_utc: string;
  transaction: {
    intent_id: string;
    receipt_id: string;
    tx_hash: string;
    timestamp_utc: string;
    vendor: string;
    wallet_id: string;
    spend_class: string;
    amount_usd: number;
    allowlist_match: boolean;
  };
  trigger_context: {
    declared_trigger: string;
    pre_action_metrics: {
      provider_failure_rate: number;
      rate_limit_rate: number;
      combined_failure_rate: number;
      evaluation_window: string;
    };
  };
  preventive_action_evidence: {
    action_type: string;
    action_timestamp_utc: string;
    policy_binding_passed: boolean;
    intent_hash_verified: boolean;
    receipt_binding_verified: boolean;
    pre_sign_decision: string;
    post_execution_receipt_status: string;
  };
  counterfactual_model: {
    summary: string;
    unit_costs: {
      labor_hour_usd: number;
    };
    assumptions: string[];
  };
  quantified_avoided_cost: {
    emergency_engineer_hours_avoided: number;
    incident_response_hours_avoided: number;
    other_allowed_buckets: Array<{ label: string; amount_usd: number }>;
    emergency_engineer_cost_avoided_usd: number;
    incident_response_cost_avoided_usd: number;
    other_allowed_cost_avoided_usd: number;
    proven_replacement_cost_avoided_usd: number;
    unproven_estimate_usd: number;
  };
  post_event_verification: {
    post_action_metrics: {
      provider_failure_rate: number;
      rate_limit_rate: number;
      combined_failure_rate: number;
    };
    trend_summary: string;
    incident_threshold_tripped: boolean;
    sev1_occurred: boolean;
  };
  proof_completeness: ContinuityProofCompleteness;
  decision_status: {
    verdict: "proven" | "unproven";
    counted_in_cap_raise_math: boolean;
    notes?: string;
  };
};

export type ContinuityProofPackInput = {
  claim_id: string;
  trust_tier?: ContinuityProofPack["trust_tier"];
  claim_window_start_utc: string;
  claim_window_end_utc: string;
  transaction: ContinuityProofPack["transaction"];
  trigger_context: ContinuityProofPack["trigger_context"];
  preventive_action_evidence: ContinuityProofPack["preventive_action_evidence"];
  counterfactual_model: {
    summary: string;
    unit_costs?: {
      labor_hour_usd?: number;
    };
    assumptions: string[];
  };
  quantified_avoided_cost: {
    emergency_engineer_hours_avoided: number;
    incident_response_hours_avoided: number;
    other_allowed_buckets?: Array<{ label: string; amount_usd: number }>;
    unproven_estimate_usd?: number;
  };
  post_event_verification: ContinuityProofPack["post_event_verification"];
  proof_completeness: Omit<ContinuityProofCompleteness, "all_required_items_present">;
  decision_notes?: string;
};

export const continuityProofPackSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "proof_pack_schema_version",
    "claim_id",
    "budget_type",
    "policy_type",
    "trust_tier",
    "claim_window_start_utc",
    "claim_window_end_utc",
    "transaction",
    "trigger_context",
    "preventive_action_evidence",
    "counterfactual_model",
    "quantified_avoided_cost",
    "post_event_verification",
    "proof_completeness",
    "decision_status",
  ],
  properties: {
    proof_pack_schema_version: { const: PROOF_PACK_SCHEMA_VERSION },
    claim_id: { type: "string", minLength: 1 },
    budget_type: { const: "continuity_budget" },
    policy_type: { const: "continuity_budget" },
    trust_tier: { enum: ["new", "calibrated", "proven"] },
    claim_window_start_utc: { type: "string", minLength: 1 },
    claim_window_end_utc: { type: "string", minLength: 1 },
    transaction: {
      type: "object",
      additionalProperties: false,
      required: [
        "intent_id",
        "receipt_id",
        "tx_hash",
        "timestamp_utc",
        "vendor",
        "wallet_id",
        "spend_class",
        "amount_usd",
        "allowlist_match",
      ],
      properties: {
        intent_id: { type: "string", minLength: 1 },
        receipt_id: { type: "string", minLength: 1 },
        tx_hash: { type: "string", minLength: 1 },
        timestamp_utc: { type: "string", minLength: 1 },
        vendor: { type: "string", minLength: 1 },
        wallet_id: { type: "string", minLength: 1 },
        spend_class: { type: "string", minLength: 1 },
        amount_usd: { type: "number", minimum: 0 },
        allowlist_match: { type: "boolean" },
      },
    },
    trigger_context: {
      type: "object",
      additionalProperties: false,
      required: ["declared_trigger", "pre_action_metrics"],
      properties: {
        declared_trigger: { type: "string", minLength: 1 },
        pre_action_metrics: {
          type: "object",
          additionalProperties: false,
          required: [
            "provider_failure_rate",
            "rate_limit_rate",
            "combined_failure_rate",
            "evaluation_window",
          ],
          properties: {
            provider_failure_rate: { type: "number", minimum: 0 },
            rate_limit_rate: { type: "number", minimum: 0 },
            combined_failure_rate: { type: "number", minimum: 0 },
            evaluation_window: { type: "string", minLength: 1 },
          },
        },
      },
    },
    preventive_action_evidence: {
      type: "object",
      additionalProperties: false,
      required: [
        "action_type",
        "action_timestamp_utc",
        "policy_binding_passed",
        "intent_hash_verified",
        "receipt_binding_verified",
        "pre_sign_decision",
        "post_execution_receipt_status",
      ],
      properties: {
        action_type: { type: "string", minLength: 1 },
        action_timestamp_utc: { type: "string", minLength: 1 },
        policy_binding_passed: { type: "boolean" },
        intent_hash_verified: { type: "boolean" },
        receipt_binding_verified: { type: "boolean" },
        pre_sign_decision: { type: "string", minLength: 1 },
        post_execution_receipt_status: { type: "string", minLength: 1 },
      },
    },
    counterfactual_model: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "unit_costs", "assumptions"],
      properties: {
        summary: { type: "string", minLength: 1 },
        unit_costs: {
          type: "object",
          additionalProperties: false,
          required: ["labor_hour_usd"],
          properties: {
            labor_hour_usd: { type: "number", minimum: 0 },
          },
        },
        assumptions: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    },
    quantified_avoided_cost: {
      type: "object",
      additionalProperties: false,
      required: [
        "emergency_engineer_hours_avoided",
        "incident_response_hours_avoided",
        "other_allowed_buckets",
        "emergency_engineer_cost_avoided_usd",
        "incident_response_cost_avoided_usd",
        "other_allowed_cost_avoided_usd",
        "proven_replacement_cost_avoided_usd",
        "unproven_estimate_usd",
      ],
      properties: {
        emergency_engineer_hours_avoided: { type: "number", minimum: 0 },
        incident_response_hours_avoided: { type: "number", minimum: 0 },
        other_allowed_buckets: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "amount_usd"],
            properties: {
              label: { type: "string", minLength: 1 },
              amount_usd: { type: "number", minimum: 0 },
            },
          },
        },
        emergency_engineer_cost_avoided_usd: { type: "number", minimum: 0 },
        incident_response_cost_avoided_usd: { type: "number", minimum: 0 },
        other_allowed_cost_avoided_usd: { type: "number", minimum: 0 },
        proven_replacement_cost_avoided_usd: { type: "number", minimum: 0 },
        unproven_estimate_usd: { type: "number", minimum: 0 },
      },
    },
    post_event_verification: {
      type: "object",
      additionalProperties: false,
      required: [
        "post_action_metrics",
        "trend_summary",
        "incident_threshold_tripped",
        "sev1_occurred",
      ],
      properties: {
        post_action_metrics: {
          type: "object",
          additionalProperties: false,
          required: ["provider_failure_rate", "rate_limit_rate", "combined_failure_rate"],
          properties: {
            provider_failure_rate: { type: "number", minimum: 0 },
            rate_limit_rate: { type: "number", minimum: 0 },
            combined_failure_rate: { type: "number", minimum: 0 },
          },
        },
        trend_summary: { type: "string", minLength: 1 },
        incident_threshold_tripped: { type: "boolean" },
        sev1_occurred: { type: "boolean" },
      },
    },
    proof_completeness: {
      type: "object",
      additionalProperties: false,
      required: [
        "logged_risk_event",
        "timestamped_preventive_action",
        "counterfactual_model_present",
        "predeclared_unit_costs_present",
        "post_event_verification_present",
        "all_required_items_present",
      ],
      properties: {
        logged_risk_event: { type: "boolean" },
        timestamped_preventive_action: { type: "boolean" },
        counterfactual_model_present: { type: "boolean" },
        predeclared_unit_costs_present: { type: "boolean" },
        post_event_verification_present: { type: "boolean" },
        all_required_items_present: { type: "boolean" },
      },
    },
    decision_status: {
      type: "object",
      additionalProperties: false,
      required: ["verdict", "counted_in_cap_raise_math"],
      properties: {
        verdict: { enum: ["proven", "unproven"] },
        counted_in_cap_raise_math: { type: "boolean" },
        notes: { type: "string" },
      },
    },
  },
} as const;

export function computeProofCompleteness(
  input: ContinuityProofPackInput["proof_completeness"],
): ContinuityProofCompleteness {
  const all_required_items_present =
    input.logged_risk_event &&
    input.timestamped_preventive_action &&
    input.counterfactual_model_present &&
    input.predeclared_unit_costs_present &&
    input.post_event_verification_present;

  return {
    ...input,
    all_required_items_present,
  };
}

export function generateContinuityProofPack(input: ContinuityProofPackInput): ContinuityProofPack {
  const labor_hour_usd = input.counterfactual_model.unit_costs?.labor_hour_usd ?? 200;
  const proof_completeness = computeProofCompleteness(input.proof_completeness);
  const other_allowed_buckets = input.quantified_avoided_cost.other_allowed_buckets ?? [];
  const other_allowed_cost_avoided_usd = other_allowed_buckets.reduce(
    (sum, bucket) => sum + bucket.amount_usd,
    0,
  );
  const emergency_engineer_cost_avoided_usd =
    input.quantified_avoided_cost.emergency_engineer_hours_avoided * labor_hour_usd;
  const incident_response_cost_avoided_usd =
    input.quantified_avoided_cost.incident_response_hours_avoided * labor_hour_usd;
  const base_total =
    emergency_engineer_cost_avoided_usd +
    incident_response_cost_avoided_usd +
    other_allowed_cost_avoided_usd;
  const initial_unproven_estimate_usd = input.quantified_avoided_cost.unproven_estimate_usd ?? 0;

  const proven_replacement_cost_avoided_usd = proof_completeness.all_required_items_present
    ? base_total
    : 0;
  const unproven_estimate_usd = proof_completeness.all_required_items_present
    ? initial_unproven_estimate_usd
    : initial_unproven_estimate_usd + base_total;

  return {
    proof_pack_schema_version: PROOF_PACK_SCHEMA_VERSION,
    claim_id: input.claim_id,
    budget_type: "continuity_budget",
    policy_type: "continuity_budget",
    trust_tier: input.trust_tier ?? "new",
    claim_window_start_utc: input.claim_window_start_utc,
    claim_window_end_utc: input.claim_window_end_utc,
    transaction: input.transaction,
    trigger_context: input.trigger_context,
    preventive_action_evidence: input.preventive_action_evidence,
    counterfactual_model: {
      summary: input.counterfactual_model.summary,
      unit_costs: { labor_hour_usd },
      assumptions: input.counterfactual_model.assumptions,
    },
    quantified_avoided_cost: {
      emergency_engineer_hours_avoided:
        input.quantified_avoided_cost.emergency_engineer_hours_avoided,
      incident_response_hours_avoided:
        input.quantified_avoided_cost.incident_response_hours_avoided,
      other_allowed_buckets,
      emergency_engineer_cost_avoided_usd,
      incident_response_cost_avoided_usd,
      other_allowed_cost_avoided_usd,
      proven_replacement_cost_avoided_usd,
      unproven_estimate_usd,
    },
    post_event_verification: input.post_event_verification,
    proof_completeness,
    decision_status: {
      verdict: proof_completeness.all_required_items_present ? "proven" : "unproven",
      counted_in_cap_raise_math: proof_completeness.all_required_items_present,
      notes: input.decision_notes,
    },
  };
}
