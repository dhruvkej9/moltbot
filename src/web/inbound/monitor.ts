import type { AnyMessageContent, proto, WAMessage } from "@whiskeysockets/baileys";
import { DisconnectReason, isJidGroup } from "@whiskeysockets/baileys";
import { createInboundDebouncer } from "../../auto-reply/inbound-debounce.js";
import { formatLocationText } from "../../channels/location.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { getChildLogger } from "../../logging/logger.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { saveMediaBuffer } from "../../media/store.js";
import { jidToE164, resolveJidToE164 } from "../../utils.js";
import { createWaSocket, getStatusCode, waitForWaConnection } from "../session.js";
import { checkInboundAccessControl } from "./access-control.js";
import { isRecentInboundMessage } from "./dedupe.js";
import {
  describeReplyContext,
  extractLocationData,
  extractMediaPlaceholder,
  extractMentionedJids,
  extractText,
} from "./extract.js";
import { downloadInboundMedia } from "./media.js";
import {
  createWebSendApi,
  extractMentionJids,
  injectMentionTokens,
  ParticipantMentionInfo,
  resolveMentionJids,
} from "./send-api.js";
import type { WebInboundMessage, WebListenerCloseReason } from "./types.js";

const OUTBOUND_MENTION_TOKEN_REGEX =
  /@(\+?\d{6,20})(?:@(s\.whatsapp\.net|lid|hosted\.lid|hosted))?/gi;
const MENTION_LEFT_BOUNDARY = /[\s([{"'`<]/;
const MENTION_RIGHT_BOUNDARY = /[\s)\]}"'`>.,!?;:]/;
const TAG_INTENT_REGEX = /\b(?:tag|mention|ping)\b/i;
const SELF_MENTION_REGEX = /\b(?:me|myself|mujhe|muje|mujhko|mujko|merko|mereko|meko)\b/i;

type MentionPolicy = {
  allowedUsers: Set<string>;
  preferredJidByUser: Map<string, string>;
};

function hasMentionBoundary(text: string, start: number, end: number): boolean {
  const prev = start > 0 ? text[start - 1] : undefined;
  const next = end < text.length ? text[end] : undefined;
  const leftOk = prev === undefined || MENTION_LEFT_BOUNDARY.test(prev);
  const rightOk = next === undefined || MENTION_RIGHT_BOUNDARY.test(next);
  return leftOk && rightOk;
}

function extractDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function extractMentionUser(value: string): string {
  return value.split("@")[0] ?? "";
}

function normalizeMentionUser(value: string): string {
  const digits = extractDigits(value);
  return digits || value;
}

function preferredParticipantJid(participant: ParticipantMentionInfo): string {
  const phoneDigits = extractDigits(participant.phoneNumber ?? "");
  if (phoneDigits.length >= 6) {
    return `${phoneDigits}@s.whatsapp.net`;
  }
  return participant.jid;
}

function buildPreferredMentionMap(
  participants: ParticipantMentionInfo[] | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const participant of participants ?? []) {
    const preferredJid = preferredParticipantJid(participant);
    const preferredUser = normalizeMentionUser(extractMentionUser(preferredJid));
    const participantUser = normalizeMentionUser(extractMentionUser(participant.jid));
    if (preferredUser) {
      map.set(preferredUser, preferredJid);
    }
    if (participantUser) {
      map.set(participantUser, preferredJid);
    }
  }
  return map;
}

function isWordChar(ch: string | undefined): boolean {
  return Boolean(ch && /[a-z0-9_]/i.test(ch));
}

function includesName(text: string, name: string): boolean {
  const hay = text.toLowerCase();
  const needle = name.trim().toLowerCase();
  if (!needle) {
    return false;
  }
  let idx = hay.indexOf(needle);
  while (idx >= 0) {
    const prev = idx > 0 ? hay[idx - 1] : undefined;
    const next = idx + needle.length < hay.length ? hay[idx + needle.length] : undefined;
    if (!isWordChar(prev) && !isWordChar(next)) {
      return true;
    }
    idx = hay.indexOf(needle, idx + 1);
  }
  return false;
}

function resolveMentionPolicy(params: {
  inboundBody: string;
  mentionedJids?: string[];
  senderJid?: string;
  senderE164?: string;
  participants?: ParticipantMentionInfo[];
}): MentionPolicy | null {
  if (!TAG_INTENT_REGEX.test(params.inboundBody)) {
    return null;
  }

  const preferredJidByUser = buildPreferredMentionMap(params.participants);
  const requestedUsers = new Set<string>();

  for (const mentionJid of extractMentionJids(params.inboundBody)) {
    const user = normalizeMentionUser(extractMentionUser(mentionJid));
    if (!user) {
      continue;
    }
    requestedUsers.add(user);
  }
  for (const mentionJid of params.mentionedJids ?? []) {
    const user = normalizeMentionUser(extractMentionUser(mentionJid));
    if (!user) {
      continue;
    }
    requestedUsers.add(user);
  }

  for (const participant of params.participants ?? []) {
    const names = [participant.name, participant.notify].filter((value): value is string =>
      Boolean(value && value.trim().length >= 3),
    );
    for (const candidateName of names) {
      if (includesName(params.inboundBody, candidateName)) {
        const user = normalizeMentionUser(extractMentionUser(preferredParticipantJid(participant)));
        if (user) {
          requestedUsers.add(user);
        }
        break;
      }
    }
  }

  if (requestedUsers.size > 0) {
    const normalizedUsers = new Set<string>();
    for (const user of requestedUsers) {
      const preferredJid = preferredJidByUser.get(user);
      if (preferredJid) {
        normalizedUsers.add(normalizeMentionUser(extractMentionUser(preferredJid)));
        continue;
      }
      normalizedUsers.add(user);
      if (!preferredJidByUser.has(user)) {
        preferredJidByUser.set(user, `${user}@s.whatsapp.net`);
      }
    }
    return { allowedUsers: normalizedUsers, preferredJidByUser };
  }

  const senderUser = normalizeMentionUser(
    extractMentionUser(params.senderJid ?? params.senderE164 ?? ""),
  );
  if (!senderUser) {
    return null;
  }

  if (!preferredJidByUser.has(senderUser)) {
    preferredJidByUser.set(senderUser, `${senderUser}@s.whatsapp.net`);
  }
  const allowSender =
    SELF_MENTION_REGEX.test(params.inboundBody) || TAG_INTENT_REGEX.test(params.inboundBody);
  if (!allowSender) {
    return null;
  }
  return { allowedUsers: new Set([senderUser]), preferredJidByUser };
}

function stripDisallowedMentionTokens(text: string, allowedUsers: Set<string>): string {
  let changed = false;
  OUTBOUND_MENTION_TOKEN_REGEX.lastIndex = 0;
  const stripped = text.replace(
    OUTBOUND_MENTION_TOKEN_REGEX,
    (
      token: string,
      rawNumber: string,
      _domain: string | undefined,
      offset: number,
      fullText: string,
    ) => {
      const start = Number(offset);
      const end = start + token.length;
      if (!hasMentionBoundary(fullText, start, end)) {
        return token;
      }
      const user = normalizeMentionUser(rawNumber);
      if (!user || allowedUsers.has(user)) {
        return `@${user}`;
      }
      changed = true;
      return "";
    },
  );
  if (!changed) {
    return stripped;
  }
  return stripped
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function userFromJid(jid: string): string {
  return normalizeMentionUser(extractMentionUser(jid));
}

export async function monitorWebInbox(options: {
  verbose: boolean;
  accountId: string;
  authDir: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
  mediaMaxMb?: number;
  /** Send read receipts for incoming messages (default true). */
  sendReadReceipts?: boolean;
  /** Debounce window (ms) for batching rapid consecutive messages from the same sender (0 to disable). */
  debounceMs?: number;
  /** Optional debounce gating predicate. */
  shouldDebounce?: (msg: WebInboundMessage) => boolean;
}) {
  const inboundLogger = getChildLogger({ module: "web-inbound" });
  const inboundConsoleLog = createSubsystemLogger("gateway/channels/whatsapp").child("inbound");
  const sock = await createWaSocket(false, options.verbose, {
    authDir: options.authDir,
  });
  await waitForWaConnection(sock);
  const connectedAtMs = Date.now();

  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };

  try {
    await sock.sendPresenceUpdate("available");
    if (shouldLogVerbose()) {
      logVerbose("Sent global 'available' presence on connect");
    }
  } catch (err) {
    logVerbose(`Failed to send 'available' presence on connect: ${String(err)}`);
  }

  const selfJid = sock.user?.id;
  const selfE164 = selfJid ? jidToE164(selfJid) : null;
  const debouncer = createInboundDebouncer<WebInboundMessage>({
    debounceMs: options.debounceMs ?? 0,
    buildKey: (msg) => {
      const senderKey =
        msg.chatType === "group"
          ? (msg.senderJid ?? msg.senderE164 ?? msg.senderName ?? msg.from)
          : msg.from;
      if (!senderKey) {
        return null;
      }
      const conversationKey = msg.chatType === "group" ? msg.chatId : msg.from;
      return `${msg.accountId}:${conversationKey}:${senderKey}`;
    },
    shouldDebounce: options.shouldDebounce,
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await options.onMessage(last);
        return;
      }
      const mentioned = new Set<string>();
      for (const entry of entries) {
        for (const jid of entry.mentionedJids ?? []) {
          mentioned.add(jid);
        }
      }
      const combinedBody = entries
        .map((entry) => entry.body)
        .filter(Boolean)
        .join("\n");
      const combinedMessage: WebInboundMessage = {
        ...last,
        body: combinedBody,
        mentionedJids: mentioned.size > 0 ? Array.from(mentioned) : undefined,
      };
      await options.onMessage(combinedMessage);
    },
    onError: (err) => {
      inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
      inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
    },
  });
  const groupMetaCache = new Map<
    string,
    {
      subject?: string;
      participants?: string[];
      participantInfo?: ParticipantMentionInfo[];
      expires: number;
    }
  >();
  const GROUP_META_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const lidLookup = sock.signalRepository?.lidMapping;

  const resolveInboundJid = async (jid: string | null | undefined): Promise<string | null> =>
    resolveJidToE164(jid, { authDir: options.authDir, lidLookup });

  const getGroupMeta = async (jid: string) => {
    const cached = groupMetaCache.get(jid);
    if (cached && cached.expires > Date.now()) {
      return cached;
    }
    try {
      const meta = await sock.groupMetadata(jid);
      const participantInfo: ParticipantMentionInfo[] =
        meta.participants?.map((p) => ({
          jid: p.id,
          name: p.name,
          notify: p.notify,
          phoneNumber: p.phoneNumber,
        })) ?? [];
      const participants =
        (
          await Promise.all(
            meta.participants?.map(async (p) => {
              const mapped = await resolveInboundJid(p.id);
              return mapped ?? p.id;
            }) ?? [],
          )
        ).filter(Boolean) ?? [];
      const entry = {
        subject: meta.subject,
        participants,
        participantInfo,
        expires: Date.now() + GROUP_META_TTL_MS,
      };
      groupMetaCache.set(jid, entry);
      return entry;
    } catch (err) {
      logVerbose(`Failed to fetch group metadata for ${jid}: ${String(err)}`);
      return { expires: Date.now() + GROUP_META_TTL_MS };
    }
  };

  const handleMessagesUpsert = async (upsert: { type?: string; messages?: Array<WAMessage> }) => {
    if (upsert.type !== "notify" && upsert.type !== "append") {
      return;
    }
    for (const msg of upsert.messages ?? []) {
      recordChannelActivity({
        channel: "whatsapp",
        accountId: options.accountId,
        direction: "inbound",
      });
      const id = msg.key?.id ?? undefined;
      const remoteJid = msg.key?.remoteJid;
      if (!remoteJid) {
        continue;
      }
      if (remoteJid.endsWith("@status") || remoteJid.endsWith("@broadcast")) {
        continue;
      }

      const group = isJidGroup(remoteJid) === true;
      if (id) {
        const dedupeKey = `${options.accountId}:${remoteJid}:${id}`;
        if (isRecentInboundMessage(dedupeKey)) {
          continue;
        }
      }
      const participantJid = msg.key?.participant ?? undefined;
      const from = group ? remoteJid : await resolveInboundJid(remoteJid);
      if (!from) {
        continue;
      }
      const senderE164 = group
        ? participantJid
          ? await resolveInboundJid(participantJid)
          : null
        : from;

      let groupSubject: string | undefined;
      let groupParticipants: string[] | undefined;
      let groupParticipantInfo: ParticipantMentionInfo[] | undefined;
      if (group) {
        const meta = await getGroupMeta(remoteJid);
        groupSubject = meta.subject;
        groupParticipants = meta.participants;
        groupParticipantInfo = meta.participantInfo;
      }
      const messageTimestampMs = msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : undefined;

      const access = await checkInboundAccessControl({
        accountId: options.accountId,
        from,
        selfE164,
        senderE164,
        group,
        pushName: msg.pushName ?? undefined,
        isFromMe: Boolean(msg.key?.fromMe),
        messageTimestampMs,
        connectedAtMs,
        sock: { sendMessage: (jid, content) => sock.sendMessage(jid, content) },
        remoteJid,
      });
      if (!access.allowed) {
        continue;
      }

      if (id && !access.isSelfChat && options.sendReadReceipts !== false) {
        const participant = msg.key?.participant;
        try {
          await sock.readMessages([{ remoteJid, id, participant, fromMe: false }]);
          if (shouldLogVerbose()) {
            const suffix = participant ? ` (participant ${participant})` : "";
            logVerbose(`Marked message ${id} as read for ${remoteJid}${suffix}`);
          }
        } catch (err) {
          logVerbose(`Failed to mark message ${id} read: ${String(err)}`);
        }
      } else if (id && access.isSelfChat && shouldLogVerbose()) {
        // Self-chat mode: never auto-send read receipts (blue ticks) on behalf of the owner.
        logVerbose(`Self-chat mode: skipping read receipt for ${id}`);
      }

      // If this is history/offline catch-up, mark read above but skip auto-reply.
      if (upsert.type === "append") {
        continue;
      }

      const location = extractLocationData(msg.message ?? undefined);
      const locationText = location ? formatLocationText(location) : undefined;
      let body = extractText(msg.message ?? undefined);
      if (locationText) {
        body = [body, locationText].filter(Boolean).join("\n").trim();
      }
      if (!body) {
        body = extractMediaPlaceholder(msg.message ?? undefined);
        if (!body) {
          continue;
        }
      }
      const replyContext = describeReplyContext(msg.message as proto.IMessage | undefined);

      let mediaPath: string | undefined;
      let mediaType: string | undefined;
      let mediaFileName: string | undefined;
      try {
        const inboundMedia = await downloadInboundMedia(msg as proto.IWebMessageInfo, sock);
        if (inboundMedia) {
          const maxMb =
            typeof options.mediaMaxMb === "number" && options.mediaMaxMb > 0
              ? options.mediaMaxMb
              : 50;
          const maxBytes = maxMb * 1024 * 1024;
          const saved = await saveMediaBuffer(
            inboundMedia.buffer,
            inboundMedia.mimetype,
            "inbound",
            maxBytes,
            inboundMedia.fileName,
          );
          mediaPath = saved.path;
          mediaType = inboundMedia.mimetype;
          mediaFileName = inboundMedia.fileName;
        }
      } catch (err) {
        logVerbose(`Inbound media download failed: ${String(err)}`);
      }

      const chatJid = remoteJid;
      const mentionedJids = extractMentionedJids(msg.message as proto.IMessage | undefined);
      const mentionPolicy = resolveMentionPolicy({
        inboundBody: body,
        mentionedJids: mentionedJids ?? undefined,
        senderJid: participantJid,
        senderE164: senderE164 ?? undefined,
        participants: groupParticipantInfo,
      });
      const resolveOutboundMentions = async (text: string) => {
        const policyText = mentionPolicy
          ? stripDisallowedMentionTokens(text, mentionPolicy.allowedUsers)
          : text;
        let mentionJids = await resolveMentionJids(policyText, {
          lidLookup,
          participants: groupParticipantInfo,
        });

        if (mentionPolicy) {
          mentionJids = mentionJids.filter((jid) =>
            mentionPolicy.allowedUsers.has(userFromJid(jid)),
          );
          if (mentionJids.length === 0) {
            mentionJids = [...mentionPolicy.allowedUsers].map(
              (user) => mentionPolicy.preferredJidByUser.get(user) ?? `${user}@s.whatsapp.net`,
            );
          }
        }

        return {
          mentionJids,
          outgoingText: injectMentionTokens(policyText, mentionJids),
        };
      };
      const sendComposing = async () => {
        try {
          await sock.sendPresenceUpdate("composing", chatJid);
        } catch (err) {
          logVerbose(`Presence update failed: ${String(err)}`);
        }
      };
      const reply = async (text: string) => {
        const { mentionJids, outgoingText } = await resolveOutboundMentions(text);
        const mentionPayload = mentionJids.length > 0 ? { mentions: mentionJids } : {};
        await sock.sendMessage(chatJid, { text: outgoingText, ...mentionPayload });
      };
      const sendMedia = async (payload: AnyMessageContent) => {
        const caption = (payload as { caption?: unknown }).caption;
        const body = typeof caption === "string" ? caption : "";
        if (!body) {
          await sock.sendMessage(chatJid, payload);
          return;
        }

        const { mentionJids, outgoingText: mentionCaption } = await resolveOutboundMentions(body);
        if (mentionJids.length === 0) {
          await sock.sendMessage(chatJid, payload);
          return;
        }

        await sock.sendMessage(chatJid, {
          ...payload,
          caption: mentionCaption,
          mentions: mentionJids,
        });
      };
      const timestamp = messageTimestampMs;
      const senderName = msg.pushName ?? undefined;

      inboundLogger.info(
        { from, to: selfE164 ?? "me", body, mediaPath, mediaType, mediaFileName, timestamp },
        "inbound message",
      );
      const inboundMessage: WebInboundMessage = {
        id,
        from,
        conversationId: from,
        to: selfE164 ?? "me",
        accountId: access.resolvedAccountId,
        body,
        pushName: senderName,
        timestamp,
        chatType: group ? "group" : "direct",
        chatId: remoteJid,
        senderJid: participantJid,
        senderE164: senderE164 ?? undefined,
        senderName,
        replyToId: replyContext?.id,
        replyToBody: replyContext?.body,
        replyToSender: replyContext?.sender,
        replyToSenderJid: replyContext?.senderJid,
        replyToSenderE164: replyContext?.senderE164,
        groupSubject,
        groupParticipants,
        mentionedJids: mentionedJids ?? undefined,
        selfJid,
        selfE164,
        location: location ?? undefined,
        sendComposing,
        reply,
        sendMedia,
        mediaPath,
        mediaType,
        mediaFileName,
      };
      try {
        const task = Promise.resolve(debouncer.enqueue(inboundMessage));
        void task.catch((err) => {
          inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
          inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
        });
      } catch (err) {
        inboundLogger.error({ error: String(err) }, "failed handling inbound web message");
        inboundConsoleLog.error(`Failed handling inbound web message: ${String(err)}`);
      }
    }
  };
  sock.ev.on("messages.upsert", handleMessagesUpsert);

  const handleConnectionUpdate = (
    update: Partial<import("@whiskeysockets/baileys").ConnectionState>,
  ) => {
    try {
      if (update.connection === "close") {
        const status = getStatusCode(update.lastDisconnect?.error);
        resolveClose({
          status,
          isLoggedOut: status === DisconnectReason.loggedOut,
          error: update.lastDisconnect?.error,
        });
      }
    } catch (err) {
      inboundLogger.error({ error: String(err) }, "connection.update handler error");
      resolveClose({ status: undefined, isLoggedOut: false, error: err });
    }
  };
  sock.ev.on("connection.update", handleConnectionUpdate);

  const sendApi = createWebSendApi({
    sock: {
      sendMessage: (jid: string, content: AnyMessageContent) => sock.sendMessage(jid, content),
      sendPresenceUpdate: (presence, jid?: string) => sock.sendPresenceUpdate(presence, jid),
    },
    defaultAccountId: options.accountId,
    lidLookup,
    getParticipants: () => {
      const allParticipants: ParticipantMentionInfo[] = [];
      for (const meta of groupMetaCache.values()) {
        if (meta.participantInfo) {
          allParticipants.push(...meta.participantInfo);
        }
      }
      return allParticipants;
    },
  });

  return {
    close: async () => {
      try {
        const ev = sock.ev as unknown as {
          off?: (event: string, listener: (...args: unknown[]) => void) => void;
          removeListener?: (event: string, listener: (...args: unknown[]) => void) => void;
        };
        const messagesUpsertHandler = handleMessagesUpsert as unknown as (
          ...args: unknown[]
        ) => void;
        const connectionUpdateHandler = handleConnectionUpdate as unknown as (
          ...args: unknown[]
        ) => void;
        if (typeof ev.off === "function") {
          ev.off("messages.upsert", messagesUpsertHandler);
          ev.off("connection.update", connectionUpdateHandler);
        } else if (typeof ev.removeListener === "function") {
          ev.removeListener("messages.upsert", messagesUpsertHandler);
          ev.removeListener("connection.update", connectionUpdateHandler);
        }
        sock.ws?.close();
      } catch (err) {
        logVerbose(`Socket close failed: ${String(err)}`);
      }
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { status: undefined, isLoggedOut: false, error: "closed" });
    },
    // IPC surface (sendMessage/sendPoll/sendReaction/sendComposingTo)
    ...sendApi,
  } as const;
}
