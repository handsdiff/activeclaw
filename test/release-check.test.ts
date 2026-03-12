import { describe, expect, it } from "vitest";
import {
  collectBundledExtensionManifestErrors,
  collectBundledExtensionRootDependencyGapErrors,
} from "../scripts/release-check.ts";

describe("collectBundledExtensionRootDependencyGapErrors", () => {
  it("allows known gaps but still flags unallowlisted ones", () => {
    expect(
      collectBundledExtensionRootDependencyGapErrors({
        rootPackage: { dependencies: {} },
        extensions: [
          {
            id: "googlechat",
            packageJson: {
              dependencies: { "google-auth-library": "^1.0.0" },
              openclaw: {
                install: { npmSpec: "@openclaw/googlechat" },
                releaseChecks: {
                  rootDependencyMirrorAllowlist: ["google-auth-library"],
                },
              },
            },
          },
          {
            id: "feishu",
            packageJson: {
              dependencies: { "@larksuiteoapi/node-sdk": "^1.59.0" },
              openclaw: { install: { npmSpec: "@openclaw/feishu" } },
            },
          },
        ],
      }),
    ).toEqual([
      "bundled extension 'feishu' root dependency mirror drift | missing in root package: @larksuiteoapi/node-sdk | new gaps: @larksuiteoapi/node-sdk",
    ]);
  });

  it("flags newly introduced bundled extension dependency gaps", () => {
    expect(
      collectBundledExtensionRootDependencyGapErrors({
        rootPackage: { dependencies: {} },
        extensions: [
          {
            id: "googlechat",
            packageJson: {
              dependencies: { "google-auth-library": "^1.0.0", undici: "^7.0.0" },
              openclaw: {
                install: { npmSpec: "@openclaw/googlechat" },
                releaseChecks: {
                  rootDependencyMirrorAllowlist: ["google-auth-library"],
                },
              },
            },
          },
        ],
      }),
    ).toEqual([
      "bundled extension 'googlechat' root dependency mirror drift | missing in root package: google-auth-library, undici | new gaps: undici",
    ]);
  });

  it("flags stale allowlist entries once a gap is resolved", () => {
    expect(
      collectBundledExtensionRootDependencyGapErrors({
        rootPackage: { dependencies: { "google-auth-library": "^1.0.0" } },
        extensions: [
          {
            id: "googlechat",
            packageJson: {
              dependencies: { "google-auth-library": "^1.0.0" },
              openclaw: {
                install: { npmSpec: "@openclaw/googlechat" },
                releaseChecks: {
                  rootDependencyMirrorAllowlist: ["google-auth-library"],
                },
              },
            },
          },
        ],
      }),
    ).toEqual([
      "bundled extension 'googlechat' root dependency mirror drift | missing in root package: (none) | remove stale allowlist entries: google-auth-library",
    ]);
  });
});

describe("collectBundledExtensionManifestErrors", () => {
  it("flags invalid bundled extension install metadata", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: { npmSpec: "   " },
            },
          },
        },
      ]),
    ).toEqual([
      "bundled extension 'broken' manifest invalid | openclaw.install.npmSpec must be a non-empty string",
    ]);
  });

  it("flags invalid release-check allowlist metadata", () => {
    expect(
      collectBundledExtensionManifestErrors([
        {
          id: "broken",
          packageJson: {
            openclaw: {
              install: { npmSpec: "@openclaw/broken" },
              releaseChecks: {
                rootDependencyMirrorAllowlist: ["ok", ""],
              },
            },
          },
        },
      ]),
    ).toEqual([
      "bundled extension 'broken' manifest invalid | openclaw.releaseChecks.rootDependencyMirrorAllowlist must contain only non-empty strings",
    ]);
  });
});
