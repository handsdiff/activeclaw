import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxContainerInfo } from "../agents/sandbox.js";

const mocks = vi.hoisted(() => ({
  listSandboxContainers: vi.fn(),
  removeSandboxContainer: vi.fn(),
  clackConfirm: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => ({
  listSandboxContainers: mocks.listSandboxContainers,
  removeSandboxContainer: mocks.removeSandboxContainer,
}));

vi.mock("@clack/prompts", () => ({
  confirm: mocks.clackConfirm,
}));

import { sandboxListCommand, sandboxRecreateCommand } from "./sandbox.js";

const NOW = Date.now();

function createContainer(overrides: Partial<SandboxContainerInfo> = {}): SandboxContainerInfo {
  return {
    containerName: "openclaw-sandbox-test",
    sessionKey: "test-session",
    image: "openclaw/sandbox:latest",
    imageMatch: true,
    running: true,
    createdAtMs: NOW - 3_600_000,
    lastUsedAtMs: NOW - 600_000,
    ...overrides,
  };
}

function createMockRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function setupDefaultMocks() {
  mocks.listSandboxContainers.mockResolvedValue([]);
  mocks.removeSandboxContainer.mockResolvedValue(undefined);
  mocks.clackConfirm.mockResolvedValue(true);
}

function expectLogContains(runtime: ReturnType<typeof createMockRuntime>, text: string) {
  expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining(text));
}

function expectErrorContains(runtime: ReturnType<typeof createMockRuntime>, text: string) {
  expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(text));
}

describe("sandboxListCommand", () => {
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    runtime = createMockRuntime();
  });

  it("displays sandbox containers", async () => {
    const container1 = createContainer({ containerName: "container-1" });
    const container2 = createContainer({ containerName: "container-2", imageMatch: false });
    mocks.listSandboxContainers.mockResolvedValue([container1, container2]);

    await sandboxListCommand({ json: false }, runtime as never);

    expectLogContains(runtime, "📦 Sandbox Containers");
    expectLogContains(runtime, container1.containerName);
    expectLogContains(runtime, container2.containerName);
    expectLogContains(runtime, "Total");
  });

  it("shows warning when image mismatches are detected", async () => {
    mocks.listSandboxContainers.mockResolvedValue([createContainer({ imageMatch: false })]);

    await sandboxListCommand({ json: false }, runtime as never);

    expectLogContains(runtime, "⚠️");
    expectLogContains(runtime, "image mismatch");
    expectLogContains(runtime, "sandbox recreate --all");
  });

  it("shows message when no containers are found", async () => {
    await sandboxListCommand({ json: false }, runtime as never);

    expect(runtime.log).toHaveBeenCalledWith("No sandbox containers found.");
  });

  it("outputs JSON when requested", async () => {
    const container = createContainer();
    mocks.listSandboxContainers.mockResolvedValue([container]);

    await sandboxListCommand({ json: true }, runtime as never);

    const loggedJson = runtime.log.mock.calls[0][0];
    const parsed = JSON.parse(loggedJson);
    expect(parsed.containers).toHaveLength(1);
    expect(parsed.containers[0].containerName).toBe(container.containerName);
  });

  it("handles list errors gracefully", async () => {
    mocks.listSandboxContainers.mockRejectedValue(new Error("Docker not available"));

    await sandboxListCommand({ json: false }, runtime as never);

    expect(runtime.log).toHaveBeenCalledWith("No sandbox containers found.");
  });
});

describe("sandboxRecreateCommand", () => {
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    runtime = createMockRuntime();
  });

  it("errors if no filter is specified", async () => {
    await sandboxRecreateCommand({ all: false, force: false }, runtime as never);

    expectErrorContains(runtime, "Please specify --all, --session <key>, or --agent <id>");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.listSandboxContainers).not.toHaveBeenCalled();
  });

  it("errors if multiple filters are specified", async () => {
    await sandboxRecreateCommand({ all: true, session: "test", force: false }, runtime as never);

    expectErrorContains(runtime, "Please specify only one of: --all, --session, --agent");
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.listSandboxContainers).not.toHaveBeenCalled();
  });

  it("filters by session", async () => {
    const match = createContainer({ sessionKey: "target-session" });
    const noMatch = createContainer({ sessionKey: "other-session" });
    mocks.listSandboxContainers.mockResolvedValue([match, noMatch]);

    await sandboxRecreateCommand(
      { session: "target-session", all: false, force: true },
      runtime as never,
    );

    expect(mocks.removeSandboxContainer).toHaveBeenCalledTimes(1);
    expect(mocks.removeSandboxContainer).toHaveBeenCalledWith(match.containerName);
  });

  it("filters by agent prefix", async () => {
    const agent = createContainer({ sessionKey: "agent:work" });
    const agentSub = createContainer({ sessionKey: "agent:work:subtask" });
    const other = createContainer({ sessionKey: "test-session" });
    mocks.listSandboxContainers.mockResolvedValue([agent, agentSub, other]);

    await sandboxRecreateCommand({ agent: "work", all: false, force: true }, runtime as never);

    expect(mocks.removeSandboxContainer).toHaveBeenCalledTimes(2);
    expect(mocks.removeSandboxContainer).toHaveBeenCalledWith(agent.containerName);
    expect(mocks.removeSandboxContainer).toHaveBeenCalledWith(agentSub.containerName);
  });

  it("removes all when requested", async () => {
    mocks.listSandboxContainers.mockResolvedValue([createContainer(), createContainer()]);

    await sandboxRecreateCommand({ all: true, force: true }, runtime as never);

    expect(mocks.removeSandboxContainer).toHaveBeenCalledTimes(2);
  });

  it("requires confirmation without --force", async () => {
    mocks.listSandboxContainers.mockResolvedValue([createContainer()]);

    await sandboxRecreateCommand({ all: true, force: false }, runtime as never);

    expect(mocks.clackConfirm).toHaveBeenCalled();
    expect(mocks.removeSandboxContainer).toHaveBeenCalled();
  });

  it("cancels when confirmation is declined", async () => {
    mocks.listSandboxContainers.mockResolvedValue([createContainer()]);
    mocks.clackConfirm.mockResolvedValue(false);

    await sandboxRecreateCommand({ all: true, force: false }, runtime as never);

    expect(runtime.log).toHaveBeenCalledWith("Cancelled.");
    expect(mocks.removeSandboxContainer).not.toHaveBeenCalled();
  });

  it("skips confirmation with --force", async () => {
    mocks.listSandboxContainers.mockResolvedValue([createContainer()]);

    await sandboxRecreateCommand({ all: true, force: true }, runtime as never);

    expect(mocks.clackConfirm).not.toHaveBeenCalled();
    expect(mocks.removeSandboxContainer).toHaveBeenCalled();
  });

  it("shows a message when nothing matches", async () => {
    await sandboxRecreateCommand({ all: true, force: true }, runtime as never);

    expect(runtime.log).toHaveBeenCalledWith("No containers found matching the criteria.");
    expect(mocks.removeSandboxContainer).not.toHaveBeenCalled();
  });

  it("reports removal errors and exits non-zero", async () => {
    mocks.listSandboxContainers.mockResolvedValue([
      createContainer({ containerName: "success" }),
      createContainer({ containerName: "failure" }),
    ]);
    mocks.removeSandboxContainer
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Removal failed"));

    await sandboxRecreateCommand({ all: true, force: true }, runtime as never);

    expectErrorContains(runtime, "Failed to remove");
    expectLogContains(runtime, "1 removed, 1 failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("reports successful removal", async () => {
    mocks.listSandboxContainers.mockResolvedValue([createContainer()]);

    await sandboxRecreateCommand({ all: true, force: true }, runtime as never);

    expectLogContains(runtime, "✓ Removed");
    expectLogContains(runtime, "1 removed, 0 failed");
    expectLogContains(runtime, "automatically recreated");
  });
});
