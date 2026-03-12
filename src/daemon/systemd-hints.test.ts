import { describe, expect, it } from "vitest";
import { isSystemdUnavailableDetail, renderSystemdUnavailableHints } from "./systemd-hints.js";

describe("isSystemdUnavailableDetail", () => {
  it("matches systemd unavailable error details", () => {
    expect(
      isSystemdUnavailableDetail("systemctl --user unavailable: Failed to connect to bus"),
    ).toBe(true);
    expect(
      isSystemdUnavailableDetail(
        "systemctl not available; systemd user services are required on Linux.",
      ),
    ).toBe(true);
    expect(isSystemdUnavailableDetail("permission denied")).toBe(false);
  });
});

describe("renderSystemdUnavailableHints", () => {
  it("renders generic Linux recovery hints", () => {
    expect(renderSystemdUnavailableHints()).toEqual([
      "systemd user services are unavailable; install/enable systemd or run the gateway under your supervisor.",
      "If you're in a container, run the gateway in the foreground instead of `openclaw gateway`.",
    ]);
  });
});
