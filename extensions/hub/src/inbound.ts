import {
  createScopedPairingAccess,
  createNormalizedOutboundDeliverer,
  createReplyPrefixOptions,
  formatTextWithAttachmentLinks,
  logInboundDrop,
  readStoreAllowFromForDmPolicy,
  resolveControlCommandGate,
  resolveOutboundMediaUrls,
  resolveEffectiveAllowFromLists,
  type OutboundReplyPayload,
  type OpenClawConfig,
  type RuntimeEnv,
} from "openclaw/plugin-sdk";
import type { ResolvedHubAccount } from "./accounts.js";
import { getHubRuntime } from "./runtime.js";
import { sendMessageHub } from "./send.js";
import type { CoreConfig, HubInboundMessage } from "./types.js";

const CHANNEL_ID = "hub" as const;

function normalizeHubAllowFrom(entries: Array<string | number> | undefined): string[] {
  if (!entries) {
    return [];
  }
  return entries.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
}

function isAllowedSender(allowFrom: string[], senderId: string): boolean {
  const normalized = senderId.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return allowFrom.some((entry) => entry === "*" || entry === normalized);
}

async function deliverHubReply(params: {
  payload: OutboundReplyPayload;
  target: string;
  accountId: string;
  sendReply?: (target: string, text: string) => Promise<void>;
  statusSink?: (patch: { lastOutboundAt?: number }) => void;
}) {
  const combined = formatTextWithAttachmentLinks(
    params.payload.text,
    resolveOutboundMediaUrls(params.payload),
  );
  if (!combined) {
    return;
  }

  if (params.sendReply) {
    await params.sendReply(params.target, combined);
  } else {
    await sendMessageHub(params.target, combined, { accountId: params.accountId });
  }
  params.statusSink?.({ lastOutboundAt: Date.now() });
}

export async function handleHubInbound(params: {
  message: HubInboundMessage;
  account: ResolvedHubAccount;
  config: CoreConfig;
  runtime: RuntimeEnv;
  sendReply?: (target: string, text: string) => Promise<void>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { message, account, config, runtime, statusSink } = params;
  const core = getHubRuntime();
  const pairing = createScopedPairingAccess({
    core,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });

  const rawBody = message.text?.trim() ?? "";
  if (!rawBody) {
    return;
  }

  statusSink?.({ lastInboundAt: message.timestamp });

  const senderId = message.from;
  const dmPolicy = account.config.dmPolicy ?? "pairing";

  const configAllowFrom = normalizeHubAllowFrom(account.config.allowFrom);
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: CHANNEL_ID,
    accountId: account.accountId,
    dmPolicy,
    readStore: pairing.readStoreForDmPolicy,
  });
  const storeAllowList = normalizeHubAllowFrom(storeAllowFrom);

  const { effectiveAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: configAllowFrom,
    groupAllowFrom: [],
    storeAllowFrom: storeAllowList,
    dmPolicy,
    groupAllowFromFallbackToAllowFrom: false,
  });

  const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
    cfg: config as OpenClawConfig,
    surface: CHANNEL_ID,
  });
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowed = isAllowedSender(effectiveAllowFrom, senderId);
  const hasControlCommand = core.channel.text.hasControlCommand(rawBody, config as OpenClawConfig);
  const commandGate = resolveControlCommandGate({
    useAccessGroups,
    authorizers: [
      {
        configured: effectiveAllowFrom.length > 0,
        allowed: senderAllowed,
      },
    ],
    allowTextCommands,
    hasControlCommand,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  // DM policy enforcement (Hub is DM-only).
  if (dmPolicy === "disabled") {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "dmPolicy=disabled",
      target: senderId,
    });
    return;
  }

  if (dmPolicy !== "open") {
    if (!senderAllowed) {
      if (dmPolicy === "pairing") {
        const { code, created } = await pairing.upsertPairingRequest({
          id: senderId.toLowerCase(),
          meta: { name: senderId },
        });
        if (created) {
          try {
            const reply = core.channel.pairing.buildPairingReply({
              channel: CHANNEL_ID,
              idLine: `Your Hub id: ${senderId}`,
              code,
            });
            await deliverHubReply({
              payload: { text: reply },
              target: senderId,
              accountId: account.accountId,
              sendReply: params.sendReply,
              statusSink,
            });
          } catch (err) {
            runtime.error?.(`hub: pairing reply failed for ${senderId}: ${String(err)}`);
          }
        }
      }
      logInboundDrop({
        log: (line) => runtime.log?.(line),
        channel: CHANNEL_ID,
        reason: `dmPolicy=${dmPolicy}`,
        target: senderId,
      });
      return;
    }
  }

  if (commandGate.shouldBlock) {
    logInboundDrop({
      log: (line) => runtime.log?.(line),
      channel: CHANNEL_ID,
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return;
  }

  const peerId = senderId;
  const route = core.channel.routing.resolveAgentRoute({
    cfg: config as OpenClawConfig,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: {
      kind: "direct",
      id: peerId,
    },
  });

  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config as OpenClawConfig);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Hub",
    from: senderId,
    timestamp: message.timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `hub:${senderId}`,
    To: `hub:${senderId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: "direct",
    ConversationLabel: senderId,
    SenderName: senderId,
    SenderId: senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: message.messageId,
    Timestamp: message.timestamp,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `hub:${senderId}`,
    CommandAuthorized: commandAuthorized,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`hub: failed updating session meta: ${String(err)}`);
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg: config as OpenClawConfig,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId: account.accountId,
  });
  const deliverReply = createNormalizedOutboundDeliverer(async (payload) => {
    await deliverHubReply({
      payload,
      target: peerId,
      accountId: account.accountId,
      sendReply: params.sendReply,
      statusSink,
    });
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config as OpenClawConfig,
    dispatcherOptions: {
      ...prefixOptions,
      deliver: deliverReply,
      onError: (err, info) => {
        runtime.error?.(`hub ${info.kind} reply failed: ${String(err)}`);
      },
    },
    replyOptions: {
      onModelSelected,
    },
  });
}
