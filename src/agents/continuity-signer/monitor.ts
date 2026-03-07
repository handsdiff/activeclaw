export type RpcContinuityBin = {
  total_requests: number;
  timeouts: number;
  connection_failures: number;
  http_5xx: number;
  malformed_or_empty: number;
  provider_declared_infra_failures: number;
  http_429: number;
};

export type RpcContinuityRates = {
  provider_failure_rate: number;
  rate_limit_rate: number;
  combined_failure_rate: number;
};

export type ContinuityTriggerEvaluation = RpcContinuityRates & {
  min_requests_per_bin: number;
  eligible: boolean;
};

export function computeMinRequestsPerBin(medianRequestsPerMinLast24h?: number): number {
  if (
    medianRequestsPerMinLast24h === undefined ||
    Number.isNaN(medianRequestsPerMinLast24h) ||
    medianRequestsPerMinLast24h <= 0
  ) {
    return 50;
  }

  return Math.max(20, Math.min(100, Math.ceil(0.5 * medianRequestsPerMinLast24h)));
}

export function computeRpcContinuityRates(bin: RpcContinuityBin): RpcContinuityRates {
  if (bin.total_requests <= 0) {
    return {
      provider_failure_rate: 0,
      rate_limit_rate: 0,
      combined_failure_rate: 0,
    };
  }

  const providerFailures =
    bin.timeouts +
    bin.connection_failures +
    bin.http_5xx +
    bin.malformed_or_empty +
    bin.provider_declared_infra_failures;
  const rateLimitFailures = bin.http_429;

  const provider_failure_rate = providerFailures / bin.total_requests;
  const rate_limit_rate = rateLimitFailures / bin.total_requests;

  return {
    provider_failure_rate,
    rate_limit_rate,
    combined_failure_rate: provider_failure_rate + rate_limit_rate,
  };
}

export function evaluateContinuityBin(
  bin: RpcContinuityBin,
  medianRequestsPerMinLast24h?: number,
): ContinuityTriggerEvaluation {
  const min_requests_per_bin = computeMinRequestsPerBin(medianRequestsPerMinLast24h);
  const rates = computeRpcContinuityRates(bin);

  return {
    ...rates,
    min_requests_per_bin,
    eligible: bin.total_requests >= min_requests_per_bin,
  };
}

export function evaluateCombinedFailureTrigger(
  bins: RpcContinuityBin[],
  opts: {
    medianRequestsPerMinLast24h?: number;
    threshold?: number;
    requiredConsecutiveBins?: number;
  } = {},
): {
  tripped: boolean;
  min_requests_per_bin: number;
  required_consecutive_bins: number;
  threshold: number;
  evaluated_bins: number;
} {
  const threshold = opts.threshold ?? 0.05;
  const requiredConsecutiveBins = opts.requiredConsecutiveBins ?? 10;
  const min_requests_per_bin = computeMinRequestsPerBin(opts.medianRequestsPerMinLast24h);

  const window = bins.slice(-requiredConsecutiveBins);
  if (window.length < requiredConsecutiveBins) {
    return {
      tripped: false,
      min_requests_per_bin,
      required_consecutive_bins: requiredConsecutiveBins,
      threshold,
      evaluated_bins: window.length,
    };
  }

  const tripped = window.every((bin) => {
    const evaluation = evaluateContinuityBin(bin, opts.medianRequestsPerMinLast24h);
    return evaluation.eligible && evaluation.combined_failure_rate > threshold;
  });

  return {
    tripped,
    min_requests_per_bin,
    required_consecutive_bins: requiredConsecutiveBins,
    threshold,
    evaluated_bins: window.length,
  };
}
