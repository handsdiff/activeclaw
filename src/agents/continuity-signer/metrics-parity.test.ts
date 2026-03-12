import { describe, expect, it } from "vitest";
import { continuityNewPolicyFixture, makePreSignIntent } from "./fixtures.js";
import {
  buildPreSignMetrics,
  collectRuleMetrics,
  DERIVED_METRICS,
  lintPolicyMetricCoverage,
  RUNTIME_METRICS,
  SUPPORTED_METRICS,
} from "./metrics.js";
import type { Policy } from "./types.js";

function sorted(values: Iterable<string>): string[] {
  return [...values].toSorted();
}

const EXPECTED_RUNTIME_ONLY = new Set(["continuity_burn_24h_usd"]);

describe("continuity-signer metrics parity", () => {
  it("keeps supported metrics equal to derived ∪ runtime metrics", () => {
    const union = new Set([...DERIVED_METRICS, ...RUNTIME_METRICS]);
    expect(sorted(SUPPORTED_METRICS)).toEqual(sorted(union));
  });

  it("keeps declared derived metrics equal to actual emitted pre-sign metric keys", () => {
    const emitted = new Set(
      Object.keys(buildPreSignMetrics(continuityNewPolicyFixture, makePreSignIntent(), {})),
    );

    const declaredButNotEmitted = sorted(
      [...DERIVED_METRICS].filter((metric) => !emitted.has(metric)),
    );
    const emittedButUndeclared = sorted(
      [...emitted].filter((metric) => !DERIVED_METRICS.has(metric)),
    );

    expect({ declaredButNotEmitted, emittedButUndeclared }).toEqual({
      declaredButNotEmitted: [],
      emittedButUndeclared: [],
    });
  });

  it("keeps all rule-referenced metrics inside the supported metric set", () => {
    const unknownRuleMetrics = sorted(
      [...collectRuleMetrics(continuityNewPolicyFixture)].filter(
        (metric) => !SUPPORTED_METRICS.has(metric),
      ),
    );

    expect(unknownRuleMetrics).toEqual([]);
  });

  it("keeps runtime-only metrics explicit", () => {
    const runtimeOnly = new Set(
      [...RUNTIME_METRICS].filter((metric) => !DERIVED_METRICS.has(metric)),
    );
    expect(sorted(runtimeOnly)).toEqual(sorted(EXPECTED_RUNTIME_ONLY));
  });

  it("passes lint for supported metrics and hard-fails on unknown ones", () => {
    expect(() => lintPolicyMetricCoverage(continuityNewPolicyFixture)).not.toThrow();

    const invalidPolicy: Policy = {
      ...continuityNewPolicyFixture,
      freeze_rules: [
        {
          ...continuityNewPolicyFixture.freeze_rules[0],
          if: {
            mode: "all" as const,
            conditions: [{ metric: "unknown_runtime_metric", op: ">=", value: 1 }],
          },
        },
      ],
    };

    expect(() => lintPolicyMetricCoverage(invalidPolicy)).toThrow(
      "unknown policy metric: unknown_runtime_metric",
    );
  });
});
