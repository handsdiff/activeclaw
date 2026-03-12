import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import {
  continuityProofPackSchema,
  generateContinuityProofPack,
  PROOF_PACK_SCHEMA_VERSION,
} from "./proof-pack.js";

function makeProofPackInput() {
  return {
    claim_id: "claim_cont_rpc_topup_001",
    claim_window_start_utc: "2026-03-07T04:30:00Z",
    claim_window_end_utc: "2026-03-07T16:30:00Z",
    transaction: {
      intent_id: "intent_cont_rpc_topup_001",
      receipt_id: "receipt_cont_rpc_topup_001",
      tx_hash: "tx_hash_example_001",
      timestamp_utc: "2026-03-07T04:41:00Z",
      vendor: "vendor:alchemy",
      wallet_id: "ops_hot_01",
      spend_class: "rpc_service",
      amount_usd: 68,
      allowlist_match: true,
    },
    trigger_context: {
      declared_trigger: "combined_failure_rate > 0.05 for 10 consecutive rolling 1-minute bins",
      pre_action_metrics: {
        provider_failure_rate: 0.031,
        rate_limit_rate: 0.024,
        combined_failure_rate: 0.055,
        evaluation_window: "rolling 1-minute bins",
      },
    },
    preventive_action_evidence: {
      action_type: "primary_rpc_topup",
      action_timestamp_utc: "2026-03-07T04:41:00Z",
      policy_binding_passed: true,
      intent_hash_verified: true,
      receipt_binding_verified: true,
      pre_sign_decision: "allow",
      post_execution_receipt_status: "complete",
    },
    counterfactual_model: {
      summary:
        "Without the top-up, elevated error pressure would likely have forced manual intervention.",
      assumptions: ["Month-1 value is primarily labor avoided."],
    },
    quantified_avoided_cost: {
      emergency_engineer_hours_avoided: 4,
      incident_response_hours_avoided: 0,
      other_allowed_buckets: [{ label: "avoided_failover_invoice", amount_usd: 50 }],
      unproven_estimate_usd: 25,
    },
    post_event_verification: {
      post_action_metrics: {
        provider_failure_rate: 0.012,
        rate_limit_rate: 0.003,
        combined_failure_rate: 0.015,
      },
      trend_summary: "Combined failure rate fell below threshold after the top-up.",
      incident_threshold_tripped: false,
      sev1_occurred: false,
    },
    proof_completeness: {
      logged_risk_event: true,
      timestamped_preventive_action: true,
      counterfactual_model_present: true,
      predeclared_unit_costs_present: true,
      post_event_verification_present: true,
    },
    decision_notes: "Illustrative example.",
  };
}

describe("continuity proof pack", () => {
  it("uses the month-1 flat labor rate and validates against the schema", () => {
    const proofPack = generateContinuityProofPack(makeProofPackInput());
    const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
    const ajv = new Ajv({ strict: false });
    const validate = ajv.compile(continuityProofPackSchema);

    expect(proofPack.proof_pack_schema_version).toBe(PROOF_PACK_SCHEMA_VERSION);
    expect(proofPack.counterfactual_model.unit_costs.labor_hour_usd).toBe(200);
    expect(proofPack.quantified_avoided_cost.emergency_engineer_cost_avoided_usd).toBe(800);
    expect(proofPack.quantified_avoided_cost.other_allowed_cost_avoided_usd).toBe(50);
    expect(proofPack.quantified_avoided_cost.proven_replacement_cost_avoided_usd).toBe(850);
    expect(proofPack.quantified_avoided_cost.unproven_estimate_usd).toBe(25);
    expect(validate(proofPack), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("forces proven amount to zero when any required proof item is missing", () => {
    const proofPack = generateContinuityProofPack({
      ...makeProofPackInput(),
      proof_completeness: {
        logged_risk_event: true,
        timestamped_preventive_action: true,
        counterfactual_model_present: false,
        predeclared_unit_costs_present: true,
        post_event_verification_present: true,
      },
    });

    expect(proofPack.proof_completeness.all_required_items_present).toBe(false);
    expect(proofPack.quantified_avoided_cost.proven_replacement_cost_avoided_usd).toBe(0);
    expect(proofPack.quantified_avoided_cost.unproven_estimate_usd).toBe(875);
    expect(proofPack.decision_status.verdict).toBe("unproven");
    expect(proofPack.decision_status.counted_in_cap_raise_math).toBe(false);
  });

  it("supports explicit unproven estimates without leaking them into proven value", () => {
    const proofPack = generateContinuityProofPack({
      ...makeProofPackInput(),
      quantified_avoided_cost: {
        emergency_engineer_hours_avoided: 2,
        incident_response_hours_avoided: 1,
        other_allowed_buckets: [],
        unproven_estimate_usd: 300,
      },
    });

    expect(proofPack.quantified_avoided_cost.proven_replacement_cost_avoided_usd).toBe(600);
    expect(proofPack.quantified_avoided_cost.unproven_estimate_usd).toBe(300);
  });
});
