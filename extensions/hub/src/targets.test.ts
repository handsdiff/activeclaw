import { describe, expect, it } from "vitest";
import { normalizeHubAllowEntry, normalizeHubTarget } from "./targets.js";

describe("Hub target normalization", () => {
  it("strips a leading hub: prefix and trims whitespace", () => {
    expect(normalizeHubTarget("  hub:Brain  ")).toBe("Brain");
    expect(normalizeHubTarget("HUB:CombinatorAgent")).toBe("CombinatorAgent");
  });

  it("keeps plain agent ids intact", () => {
    expect(normalizeHubTarget("brain")).toBe("brain");
  });

  it("normalizes allowlist entries to lowercase agent ids", () => {
    expect(normalizeHubAllowEntry(" hub:Brain ")).toBe("brain");
    expect(normalizeHubAllowEntry("CombinatorAgent")).toBe("combinatoragent");
  });

  it("preserves wildcard allowlist entries", () => {
    expect(normalizeHubAllowEntry("*")).toBe("*");
    expect(normalizeHubAllowEntry("hub:*")).toBe("*");
  });

  it("returns undefined for empty values", () => {
    expect(normalizeHubTarget("")).toBeUndefined();
    expect(normalizeHubTarget("hub:")).toBeUndefined();
    expect(normalizeHubAllowEntry("   ")).toBeUndefined();
  });
});
