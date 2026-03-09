import { beforeEach, describe, expect, it, vi } from "vitest";
import { agentsDeleteCommand } from "./agents.commands.delete.js";

const requireValidConfigMock = vi.fn();
const writeConfigFileMock = vi.fn();
const moveToTrashMock = vi.fn();
const pruneAgentConfigMock = vi.fn();
const listAgentEntriesMock = vi.fn();
const findAgentEntryIndexMock = vi.fn();

vi.mock("../config/config.js", () => ({
  writeConfigFile: (...args: unknown[]) => writeConfigFileMock(...args),
}));

vi.mock("./agents.command-shared.js", () => ({
  requireValidConfig: (...args: unknown[]) => requireValidConfigMock(...args),
  createQuietRuntime: (runtime: unknown) => runtime,
}));

vi.mock("./agents.config.js", () => ({
  pruneAgentConfig: (...args: unknown[]) => pruneAgentConfigMock(...args),
  listAgentEntries: (...args: unknown[]) => listAgentEntriesMock(...args),
  findAgentEntryIndex: (...args: unknown[]) => findAgentEntryIndexMock(...args),
}));

vi.mock("./onboard-helpers.js", () => ({
  moveToTrash: (...args: unknown[]) => moveToTrashMock(...args),
}));

describe("agentsDeleteCommand history cleanup", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    requireValidConfigMock.mockResolvedValue({
      agents: {
        defaults: {
          history: {
            enabled: true,
          },
        },
        list: [
          {
            id: "worker",
            history: {
              enabled: true,
              path: "~/.openclaw/agents/{agentId}/custom-history",
            },
          },
        ],
      },
    });
    listAgentEntriesMock.mockReturnValue([{ id: "worker" }]);
    findAgentEntryIndexMock.mockReturnValue(0);
    pruneAgentConfigMock.mockReturnValue({
      config: { agents: { defaults: {}, list: [] } },
      removedBindings: 0,
      removedAllow: 0,
    });
    moveToTrashMock.mockResolvedValue(undefined);
    writeConfigFileMock.mockResolvedValue(undefined);
  });

  it("trashes the resolved custom history path for the agent", async () => {
    await agentsDeleteCommand({ id: "worker", force: true }, runtime as never);

    expect(moveToTrashMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/\.openclaw\/agents\/worker\/custom-history$/),
      runtime,
    );
  });
});
