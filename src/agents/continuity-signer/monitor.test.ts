import { describe, expect, it } from "vitest";
import {
  computeMinRequestsPerBin,
  computeRpcContinuityRates,
  evaluateCombinedFailureTrigger,
  evaluateContinuityBin,
  type RpcContinuityBin,
} from "./monitor.js";

function makeBin(overrides: Partial<RpcContinuityBin> = {}): RpcContinuityBin {
  return {
    total_requests: 100,
    timeouts: 2,
    connection_failures: 1,
    http_5xx: 1,
    malformed_or_empty: 0,
    provider_declared_infra_failures: 0,
    http_429: 2,
    ...overrides,
  };
}

describe("continuity-signer monitor", () => {
  it("uses a default min request floor of 50 without a 24h baseline", () => {
    expect(computeMinRequestsPerBin()).toBe(50);
    expect(computeMinRequestsPerBin(0)).toBe(50);
  });

  it("scales the request floor with workload and caps it between 20 and 100", () => {
    expect(computeMinRequestsPerBin(10)).toBe(20);
    expect(computeMinRequestsPerBin(80)).toBe(40);
    expect(computeMinRequestsPerBin(250)).toBe(100);
  });

  it("computes provider, rate-limit, and combined failure rates", () => {
    const rates = computeRpcContinuityRates(makeBin());

    expect(rates.provider_failure_rate).toBeCloseTo(0.04);
    expect(rates.rate_limit_rate).toBeCloseTo(0.02);
    expect(rates.combined_failure_rate).toBeCloseTo(0.06);
  });

  it("marks bins below the sample floor as ineligible", () => {
    const evaluation = evaluateContinuityBin(makeBin({ total_requests: 19 }), 40);
    expect(evaluation.min_requests_per_bin).toBe(20);
    expect(evaluation.eligible).toBe(false);
  });

  it("does not trip the trigger when bins are below the minimum sample floor", () => {
    const bins = Array.from({ length: 10 }, () => makeBin({ total_requests: 12, http_429: 6 }));
    const result = evaluateCombinedFailureTrigger(bins, { medianRequestsPerMinLast24h: 20 });

    expect(result.min_requests_per_bin).toBe(20);
    expect(result.tripped).toBe(false);
  });

  it("trips the trigger when 10 consecutive eligible bins stay above threshold", () => {
    const bins = Array.from({ length: 10 }, () =>
      makeBin({
        total_requests: 120,
        timeouts: 2,
        connection_failures: 2,
        http_5xx: 1,
        http_429: 3,
      }),
    );

    const result = evaluateCombinedFailureTrigger(bins, { medianRequestsPerMinLast24h: 120 });
    expect(result.min_requests_per_bin).toBe(60);
    expect(result.tripped).toBe(true);
  });

  it("does not trip when one bin in the window falls below threshold", () => {
    const bins = Array.from({ length: 10 }, () =>
      makeBin({
        total_requests: 120,
        timeouts: 2,
        connection_failures: 2,
        http_5xx: 1,
        http_429: 3,
      }),
    );
    bins[5] = makeBin({
      total_requests: 120,
      timeouts: 1,
      connection_failures: 0,
      http_5xx: 0,
      http_429: 1,
    });

    const result = evaluateCombinedFailureTrigger(bins, { medianRequestsPerMinLast24h: 120 });
    expect(result.tripped).toBe(false);
  });
});
