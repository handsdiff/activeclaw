import { describe, expect, it } from "vitest";
import {
  evaluateFinalDecision,
  evaluateFreeze,
  evaluatePreSign,
  verifyIntentHash,
  verifyReceiptBinding,
} from "./evaluator.js";
import {
  continuityNewPolicyFixture,
  makePreSignIntent,
  makeReceiptFromIntent,
} from "./fixtures.js";

describe("continuity-signer evaluator", () => {
  it("returns allow for a clean autosign intent", () => {
    const preSign = evaluatePreSign(
      continuityNewPolicyFixture,
      makePreSignIntent({ amount_usd: 50 }),
    );
    const freeze = evaluateFreeze(continuityNewPolicyFixture, { continuity_burn_24h_usd: 10 });
    const result = evaluateFinalDecision(preSign, freeze);

    expect(result.decision).toBe("allow");
    expect(result.reason_codes).toContain("all_pre_sign_checks_passed");
  });

  it("returns manual_review inside the manual band", () => {
    const preSign = evaluatePreSign(
      continuityNewPolicyFixture,
      makePreSignIntent({ amount_usd: 90 }),
    );
    const freeze = evaluateFreeze(continuityNewPolicyFixture, { continuity_burn_24h_usd: 10 });
    const result = evaluateFinalDecision(preSign, freeze);

    expect(preSign.decision).toBe("manual_review");
    expect(result.decision).toBe("manual_review");
    expect(result.triggered_rule_ids).toContain("manual_review_band");
  });

  it("returns reject when expected loss ceiling exceeds policy", () => {
    const preSign = evaluatePreSign(
      continuityNewPolicyFixture,
      makePreSignIntent({ expected_loss_ceiling_usd: 55 }),
    );
    const freeze = evaluateFreeze(continuityNewPolicyFixture, { continuity_burn_24h_usd: 10 });
    const result = evaluateFinalDecision(preSign, freeze);

    expect(preSign.decision).toBe("reject");
    expect(result.decision).toBe("reject");
    expect(result.reason_codes).toContain("expected_loss_ceiling_exceeded");
  });

  it("returns freeze when a freeze rule hits", () => {
    const preSign = evaluatePreSign(
      continuityNewPolicyFixture,
      makePreSignIntent({ amount_usd: 90 }),
    );
    const freeze = evaluateFreeze(continuityNewPolicyFixture, { continuity_burn_24h_usd: 50 });
    const result = evaluateFinalDecision(preSign, freeze);

    expect(freeze.decision).toBe("freeze");
    expect(result.decision).toBe("freeze");
    expect(result.freeze_scope).toBe("continuity_only");
    expect(result.triggered_rule_ids).toContain("freeze_daily_burn");
    expect(result.freeze_actions).toEqual(
      expect.arrayContaining(["disable_autosign", "notify_operator", "require_manual_review"]),
    );
  });

  it("rejects when an approval-critical intent field mutates after hashing", () => {
    const intent = makePreSignIntent();
    intent.spend_class = "backup";

    const result = verifyIntentHash(intent);
    expect(result).toEqual({ ok: false, reason: "intent_hash_mismatch" });
  });

  it("rejects when receipt counterparty drifts from the approved intent", () => {
    const intent = makePreSignIntent();
    const receipt = makeReceiptFromIntent(intent, { counterparty_or_protocol: "vendor:evil" });

    const result = verifyReceiptBinding(receipt, intent, continuityNewPolicyFixture);
    expect(result).toEqual({ ok: false, reason: "receipt_counterparty_or_protocol_mismatch" });
  });

  it("rejects when approved intent no longer matches live policy", () => {
    const intent = makePreSignIntent({ policy_id: "other_policy" });
    const result = evaluatePreSign(continuityNewPolicyFixture, intent);

    expect(result.decision).toBe("reject");
    expect(result.reason_codes).toContain("policy_binding_failed");
  });

  it("freezes instead of rejecting when policy schema is invalid on the freeze path", () => {
    const result = evaluateFreeze(
      {
        ...continuityNewPolicyFixture,
        schema_version: "0.0.0" as "1.0.0",
      },
      { continuity_burn_24h_usd: 0 },
    );

    expect(result.decision).toBe("freeze");
    expect(result.triggered_rule_ids).toContain("freeze_schema_guard");
  });
});
