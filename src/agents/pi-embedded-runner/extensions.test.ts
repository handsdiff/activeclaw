import type { Api, Model } from "@mariozechner/pi-ai";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { getCompactionSafeguardRuntime } from "../pi-extensions/compaction-safeguard-runtime.js";
import compactionSafeguardExtension from "../pi-extensions/compaction-safeguard.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";

describe("buildEmbeddedExtensionFactories", () => {
  it("does not opt safeguard mode into quality-guard retries", () => {
    const sessionManager = {} as SessionManager;
    const model = {
      id: "claude-sonnet-4-20250514",
      contextWindow: 200_000,
    } as Model<Api>;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
          },
        },
      },
    } as OpenClawConfig;

    const factories = buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      sessionKey: "agent:main:telegram:direct:123",
      runId: "run-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      model,
    });

    expect(factories).toContain(compactionSafeguardExtension);
    expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject({
      sessionKey: "agent:main:telegram:direct:123",
      runId: "run-1",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      qualityGuardEnabled: false,
    });
  });

  it("wires explicit safeguard quality-guard runtime flags", () => {
    const sessionManager = {} as SessionManager;
    const model = {
      id: "claude-sonnet-4-20250514",
      contextWindow: 200_000,
    } as Model<Api>;
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            qualityGuard: {
              enabled: true,
              maxRetries: 2,
            },
          },
        },
      },
    } as OpenClawConfig;

    const factories = buildEmbeddedExtensionFactories({
      cfg,
      sessionManager,
      sessionKey: "agent:main:telegram:direct:456",
      runId: "run-2",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      model,
    });

    expect(factories).toContain(compactionSafeguardExtension);
    expect(getCompactionSafeguardRuntime(sessionManager)).toMatchObject({
      sessionKey: "agent:main:telegram:direct:456",
      runId: "run-2",
      provider: "anthropic",
      modelId: "claude-sonnet-4-20250514",
      qualityGuardEnabled: true,
      qualityGuardMaxRetries: 2,
    });
  });
});
