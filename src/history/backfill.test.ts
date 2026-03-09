import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { backfillAgentHistory } from "./backfill.js";
import type { HistoryRecord } from "./types.js";

function isChannelRecord(
  record: HistoryRecord,
): record is Extract<HistoryRecord, { kind: "channel_message" }> {
  return record.kind === "channel_message";
}

function isCronRecord(
  record: HistoryRecord,
): record is Extract<HistoryRecord, { kind: "cron_run" }> {
  return record.kind === "cron_run";
}

function buildTranscriptText(params: {
  body: string;
  messageId: string;
  senderId: string;
  senderLabel: string;
  tsLabel: string;
  conversationLabel?: string;
  groupSubject?: string;
  replyToId?: string;
  quotedBody?: string;
  username?: string;
  isGroupChat?: boolean;
}): string {
  const conversationInfo: Record<string, unknown> = {
    message_id: params.messageId,
    sender_id: params.senderId,
    sender: params.senderLabel,
    timestamp: params.tsLabel,
  };
  if (params.conversationLabel) {
    conversationInfo.conversation_label = params.conversationLabel;
  }
  if (params.groupSubject) {
    conversationInfo.group_subject = params.groupSubject;
  }
  if (params.isGroupChat) {
    conversationInfo.is_group_chat = true;
  }
  if (params.replyToId) {
    conversationInfo.reply_to_id = params.replyToId;
  }
  const senderInfo: Record<string, unknown> = {
    label: params.senderLabel,
    id: params.senderId,
    name: params.senderLabel,
  };
  if (params.username) {
    senderInfo.username = params.username;
  }
  const parts = [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify(conversationInfo, null, 2),
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    JSON.stringify(senderInfo, null, 2),
    "```",
  ];
  if (params.quotedBody) {
    parts.push(
      "",
      "Replied message (untrusted, for context):",
      "```json",
      JSON.stringify({ sender_label: "brain", body: params.quotedBody }, null, 2),
      "```",
    );
  }
  parts.push("", params.body);
  return parts.join("\n");
}

function transcriptLines(lines: unknown[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

async function writeTranscript(filePath: string, lines: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, transcriptLines(lines), "utf-8");
}

async function readAllHistoryRecords(historyRoot: string): Promise<HistoryRecord[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }
  await walk(historyRoot);
  const records: HistoryRecord[] = [];
  for (const filePath of files) {
    const raw = await fs.readFile(filePath, "utf-8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      records.push(JSON.parse(line) as HistoryRecord);
    }
  }
  return records;
}

describe("history backfill", () => {
  let rootDir = "";
  let workspaceDir = "";
  let previousStateDir: string | undefined;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-history-backfill-"));
    workspaceDir = path.join(rootDir, "workspace");
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = rootDir;
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.mkdir(path.join(rootDir, "agents", "main", "sessions"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "cron", "runs"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, "hub-data", "messages"), { recursive: true });

    cfg = {
      cron: {
        store: path.join(rootDir, "cron", "jobs.json"),
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          history: {
            enabled: true,
            shard: {
              maxBytes: 4096,
              padWidth: 4,
            },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const store = {
      "agent:main:telegram:direct:1436148981": {
        sessionId: "live-telegram",
        updatedAt: 1772856727700,
        origin: {
          surface: "telegram",
          provider: "telegram",
          to: "telegram:1436148981",
          accountId: "default",
        },
      },
      "agent:main:hub:direct:CombinatorAgent": {
        sessionId: "live-hub",
        updatedAt: 1772856727700,
        origin: {
          surface: "hub",
          provider: "hub",
          to: "hub:CombinatorAgent",
        },
      },
      "agent:main:cron:job-1:run:cron-run-1": {
        sessionId: "cron-run-1",
        updatedAt: 1772870030470,
      },
    };
    await fs.writeFile(
      path.join(rootDir, "agents", "main", "sessions", "sessions.json"),
      JSON.stringify(store, null, 2),
      "utf-8",
    );

    await writeTranscript(path.join(rootDir, "agents", "main", "sessions", "live-telegram.jsonl"), [
      { type: "session", id: "live-telegram", timestamp: "2026-03-07T23:04:29.927Z" },
      {
        type: "message",
        id: "msg-live-user",
        timestamp: "2026-03-07T23:04:29.942Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: buildTranscriptText({
                body: "what's the session issue?",
                messageId: "7629",
                senderId: "1436148981",
                senderLabel: "hands",
                tsLabel: "Thu 2026-03-05 22:47 UTC",
                username: "handsdiff",
              }),
            },
          ],
        },
      },
      {
        type: "message",
        id: "msg-live-assistant",
        timestamp: "2026-03-07T23:04:35.985Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.4",
          content: [{ type: "text", text: "[[reply_to_current]] session issue debugged" }],
        },
      },
    ]);

    await writeTranscript(
      path.join(
        rootDir,
        "agents",
        "main",
        "sessions",
        "93b3989e-edc0-4292-939b-32d559d884e7.jsonl.archived.20260305T230235Z",
      ),
      [
        {
          type: "session",
          id: "93b3989e-edc0-4292-939b-32d559d884e7",
          timestamp: "2026-03-05T04:34:11.386Z",
        },
        {
          type: "message",
          id: "archived-user",
          timestamp: "2026-03-05T04:34:11.392Z",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: buildTranscriptText({
                  body: "quick q - whats the HUB token address?",
                  messageId: "7463",
                  senderId: "1436148981",
                  senderLabel: "hands",
                  tsLabel: "Thu 2026-03-05 04:34 UTC",
                  username: "handsdiff",
                }),
              },
            ],
          },
        },
        {
          type: "message",
          id: "archived-assistant",
          timestamp: "2026-03-05T20:51:23.977Z",
          message: {
            role: "assistant",
            provider: "openai-codex",
            model: "gpt-5.3-codex",
            content: [
              {
                type: "text",
                text: '[[reply_to_current]] Your 4-step funnel is not just "a cron idea." That is the controller + execution machinery split.',
              },
            ],
          },
        },
      ],
    );

    await writeTranscript(path.join(rootDir, "agents", "main", "sessions", "live-hub.jsonl"), [
      { type: "session", id: "live-hub", timestamp: "2026-03-07T04:12:07.699Z" },
      {
        type: "message",
        id: "hub-user",
        timestamp: "2026-03-07T04:12:07.706Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: buildTranscriptText({
                body: "Allowance policy v1?",
                messageId: "252bddd095703256",
                senderId: "CombinatorAgent",
                senderLabel: "CombinatorAgent",
                tsLabel: "Sat 2026-03-07 04:12 UTC",
              }),
            },
          ],
        },
      },
      {
        type: "message",
        id: "hub-assistant",
        timestamp: "2026-03-07T04:12:20.590Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.4",
          content: [
            { type: "text", text: "[[reply_to_current]] Allowance Policy v1 (numbers-first)." },
          ],
        },
      },
    ]);

    await writeTranscript(path.join(rootDir, "agents", "main", "sessions", "cron-run-1.jsonl"), [
      { type: "session", id: "cron-run-1", timestamp: "2026-03-07T07:53:50.469Z" },
      {
        type: "message",
        id: "cron-user",
        timestamp: "2026-03-07T07:53:50.477Z",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: "[cron:job-1 workflow-enforcement-check] Run: check the workflow state and return concise status.",
            },
          ],
        },
      },
      {
        type: "message",
        id: "cron-assistant",
        timestamp: "2026-03-07T07:54:06.116Z",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.3-codex",
          content: [{ type: "text", text: "STATUS: INTEGRATING" }],
        },
      },
      {
        type: "message",
        id: "cron-mirror",
        timestamp: "2026-03-07T07:54:16.116Z",
        message: {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          content: [{ type: "text", text: "Daily enforcement check complete." }],
        },
      },
    ]);

    await fs.writeFile(
      path.join(rootDir, "cron", "jobs.json"),
      JSON.stringify({ version: 1, jobs: [{ id: "job-1" }] }, null, 2),
      "utf-8",
    );
    await fs.writeFile(
      path.join(rootDir, "cron", "runs", "job-1.jsonl"),
      `${JSON.stringify({
        ts: 1772870038196,
        jobId: "job-1",
        action: "finished",
        status: "ok",
        summary: "STATUS: INTEGRATING",
        delivered: true,
        deliveryStatus: "delivered",
        sessionId: "cron-run-1",
        sessionKey: "agent:main:cron:job-1:run:cron-run-1",
        runAtMs: 1772870030477,
      })}\n`,
      "utf-8",
    );

    await fs.writeFile(
      path.join(workspaceDir, "hub-data", "messages", "CombinatorAgent.json"),
      JSON.stringify(
        [
          {
            id: "hub-covered-1",
            from: "brain",
            message: "This should be skipped because transcript coverage exists.",
            timestamp: "2026-03-07T04:13:00.000Z",
            read: true,
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "hub-data", "messages", "opspawn.json"),
      JSON.stringify(
        [
          {
            id: "hub-opspawn-1",
            from: "opspawn",
            message: "Inbound Hub note from opspawn",
            timestamp: "2026-02-09T04:19:32.201267",
            read: true,
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );
  });

  afterEach(async () => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("imports transcripts first, supplements Hub JSON, enriches cron runs, and stays idempotent", async () => {
    const first = await backfillAgentHistory({ cfg, agentId: "main" });
    expect(first.sessionFilesScanned).toBe(4);
    expect(first.sessionFilesImported).toBe(4);
    expect(first.hubJsonFilesScanned).toBe(2);
    expect(first.hubJsonFilesImported).toBe(1);
    expect(first.channelRecordsWritten).toBe(7);
    expect(first.cronRecordsWritten).toBe(2);

    const records = await readAllHistoryRecords(path.join(rootDir, "agents", "main", "history"));
    const archivedTelegramHit = records.find(
      (record) =>
        record.kind === "channel_message" &&
        record.conversationId === "telegram:1436148981" &&
        record.text.includes('Your 4-step funnel is not just "a cron idea."'),
    );
    expect(archivedTelegramHit).toBeTruthy();

    const combinatorRecords = records.filter(
      (record): record is Extract<HistoryRecord, { kind: "channel_message" }> =>
        isChannelRecord(record) && record.conversationId === "hub:CombinatorAgent",
    );
    expect(combinatorRecords).toHaveLength(2);

    const opspawnRecords = records.filter(
      (record): record is Extract<HistoryRecord, { kind: "channel_message" }> =>
        isChannelRecord(record) && record.conversationId === "hub:opspawn",
    );
    expect(opspawnRecords).toHaveLength(1);
    expect(opspawnRecords[0]?.direction).toBe("inbound");

    const cronRecords = records.filter(
      (record): record is Extract<HistoryRecord, { kind: "cron_run" }> =>
        isCronRecord(record) && record.jobId === "job-1",
    );
    expect(cronRecords).toHaveLength(2);
    expect(cronRecords.find((record) => record.phase === "started")?.inputText).toContain(
      "check the workflow state",
    );
    const finished = cronRecords.find((record) => record.phase === "finished");
    expect(finished?.status).toBe("ok");
    expect(finished?.deliveryStatus).toBe("delivered");
    expect(finished?.outputText).toBe("STATUS: INTEGRATING");

    const second = await backfillAgentHistory({ cfg, agentId: "main" });
    expect(second.channelRecordsWritten).toBe(0);
    expect(second.cronRecordsWritten).toBe(0);
    expect(second.duplicateRecordsSkipped).toBeGreaterThan(0);

    const recordsAfterSecondRun = await readAllHistoryRecords(
      path.join(rootDir, "agents", "main", "history"),
    );
    expect(recordsAfterSecondRun).toHaveLength(records.length);
  });
});
