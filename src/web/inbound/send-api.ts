import type { AnyMessageContent, WAPresence } from "@whiskeysockets/baileys";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { toWhatsappJid } from "../../utils.js";
import type { ActiveWebSendOptions } from "../active-listener.js";

type MentionLidLookup = {
  getLIDForPN?: (pn: string) => Promise<string | null>;
  getPNForLID?: (lid: string) => Promise<string | null>;
};

export type ParticipantMentionInfo = {
  jid: string;
  name?: string;
  notify?: string;
  phoneNumber?: string;
};

const MENTION_TOKEN_REGEX = /@(\+?\d{6,20})(?:@(s\.whatsapp\.net|lid|hosted\.lid|hosted))?/gi;
const MENTION_LEFT_BOUNDARY = /[\s([{"'`<]/;
const MENTION_RIGHT_BOUNDARY = /[\s)\]}"'`>.,!?;:]/;

function hasMentionBoundary(text: string, start: number, end: number): boolean {
  const prev = start > 0 ? text[start - 1] : undefined;
  const next = end < text.length ? text[end] : undefined;
  const leftOk = prev === undefined || MENTION_LEFT_BOUNDARY.test(prev);
  const rightOk = next === undefined || MENTION_RIGHT_BOUNDARY.test(next);
  return leftOk && rightOk;
}

function normalizeMentionDomain(domain: string | undefined): "s.whatsapp.net" | "lid" {
  const normalized = (domain ?? "").toLowerCase();
  if (normalized === "lid" || normalized === "hosted.lid") {
    return "lid";
  }
  return "s.whatsapp.net";
}

function inferMentionDomain(digits: string, explicitDomain?: string): "s.whatsapp.net" | "lid" {
  if (explicitDomain) {
    return normalizeMentionDomain(explicitDomain);
  }
  void digits;
  return "s.whatsapp.net";
}

function normalizeTextForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .trim();
}

function extractDigits(text: string): string {
  return text.replace(/\D/g, "");
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

export function extractMentionJids(text: string): string[] {
  if (!text) {
    return [];
  }

  const mentions = new Set<string>();
  MENTION_TOKEN_REGEX.lastIndex = 0;
  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const token = match[0];
    const rawNumber = match[1] ?? "";
    const rawDomain = match[2];
    const start = match.index ?? -1;
    if (start < 0) {
      continue;
    }
    const end = start + token.length;
    if (!hasMentionBoundary(text, start, end)) {
      continue;
    }

    const digits = extractDigits(rawNumber);
    if (!digits) {
      continue;
    }

    const domain = inferMentionDomain(digits, rawDomain);
    mentions.add(`${digits}@${domain}`);
  }

  return [...mentions];
}

export function extractNameMentions(text: string): string[] {
  if (!text) {
    return [];
  }
  const namePattern = /@([A-Za-z][A-Za-z0-9_\s]{1,30}?)(?=[\s)\]}"'`>.,!?;:]|$)/g;
  const names = new Set<string>();
  for (const match of text.matchAll(namePattern)) {
    const name = match[1]?.trim();
    if (name && name.length >= 2) {
      names.add(name);
    }
  }
  return [...names];
}

function normalizeMentionJid(jid: string): string {
  return jid.replace(/:\d+(?=@)/, "").replace(/@hosted\.lid$/, "@lid");
}

function mentionUserPart(jid: string): string {
  return jid.split("@")[0] ?? "";
}

function findParticipantByName(
  name: string,
  participants: ParticipantMentionInfo[],
): ParticipantMentionInfo | undefined {
  const normalizedSearch = normalizeTextForMatch(name);
  for (const p of participants) {
    if (p.name && normalizeTextForMatch(p.name) === normalizedSearch) {
      return p;
    }
    if (p.notify && normalizeTextForMatch(p.notify) === normalizedSearch) {
      return p;
    }
    const nameParts = (p.name ?? p.notify ?? "").split(/\s+/);
    for (const part of nameParts) {
      if (normalizeTextForMatch(part) === normalizedSearch) {
        return p;
      }
    }
  }
  for (const p of participants) {
    const pName = normalizeTextForMatch(p.name ?? p.notify ?? "");
    if (pName.startsWith(normalizedSearch) || normalizedSearch.startsWith(pName)) {
      if (pName.length >= 3 && normalizedSearch.length >= 3) {
        return p;
      }
    }
  }
  return undefined;
}

function resolveNameToJid(name: string, participants: ParticipantMentionInfo[]): string | null {
  const participant = findParticipantByName(name, participants);
  if (participant) {
    const phoneDigits = extractDigits(participant.phoneNumber ?? "");
    if (phoneDigits.length >= 6) {
      return `${phoneDigits}@s.whatsapp.net`;
    }
    return participant.jid;
  }
  const digits = extractDigits(name);
  if (digits.length >= 6) {
    const domain = inferMentionDomain(digits);
    return `${digits}@${domain}`;
  }
  return null;
}

export function injectMentionTokens(text: string, mentionJids: string[]): string {
  if (!mentionJids.length) {
    return text;
  }
  const existingUsers = new Set(extractMentionJids(text).map(mentionUserPart));
  const missingUsers: string[] = [];
  for (const jid of mentionJids) {
    const user = mentionUserPart(jid);
    if (!user || existingUsers.has(user)) {
      continue;
    }
    existingUsers.add(user);
    missingUsers.push(user);
  }
  if (!missingUsers.length) {
    return text;
  }
  const suffix = missingUsers.map((user) => `@${user}`).join(" ");
  if (!text.trim()) {
    return suffix;
  }
  return `${text}\n${suffix}`;
}

export async function resolveMentionJids(
  text: string,
  options?: { lidLookup?: MentionLidLookup; participants?: ParticipantMentionInfo[] },
): Promise<string[]> {
  const preferredParticipantJidByUser = new Map<string, string>();
  if (options?.participants) {
    for (const participant of options.participants) {
      const participantUser = mentionUserPart(participant.jid);
      const phoneDigits = extractDigits(participant.phoneNumber ?? "");
      const preferredJid =
        phoneDigits.length >= 6
          ? `${phoneDigits}@s.whatsapp.net`
          : normalizeMentionJid(participant.jid);
      if (participantUser) {
        preferredParticipantJidByUser.set(participantUser, preferredJid);
      }
      if (phoneDigits.length >= 6) {
        preferredParticipantJidByUser.set(phoneDigits, preferredJid);
      }
    }
  }

  const resolved = new Set<string>();
  const numericJids = extractMentionJids(text);
  for (const jid of numericJids) {
    let nextJid = normalizeMentionJid(jid);

    if (nextJid.endsWith("@lid") && options?.lidLookup?.getPNForLID) {
      try {
        const pnJid = await options.lidLookup.getPNForLID(nextJid);
        if (pnJid) {
          nextJid = normalizeMentionJid(pnJid);
        }
      } catch {
        // Best-effort lookup only.
      }
    }

    const preferredParticipantJid = preferredParticipantJidByUser.get(mentionUserPart(nextJid));
    if (preferredParticipantJid) {
      nextJid = preferredParticipantJid;
    }

    resolved.add(nextJid);
  }

  if (options?.participants && options.participants.length > 0) {
    const nameMentions = extractNameMentions(text);
    for (const name of nameMentions) {
      const jid = resolveNameToJid(name, options.participants);
      if (jid) {
        resolved.add(normalizeMentionJid(jid));
      }
    }

    for (const participant of options.participants) {
      const candidateNames = [participant.name, participant.notify].filter(
        (value): value is string => Boolean(value && value.trim().length >= 3),
      );
      for (const candidateName of candidateNames) {
        if (includesName(text, candidateName)) {
          const phoneDigits = extractDigits(participant.phoneNumber ?? "");
          resolved.add(
            phoneDigits.length >= 6
              ? `${phoneDigits}@s.whatsapp.net`
              : normalizeMentionJid(participant.jid),
          );
          break;
        }
      }
    }
  }

  return [...resolved];
}

function recordWhatsAppOutbound(accountId: string) {
  recordChannelActivity({
    channel: "whatsapp",
    accountId,
    direction: "outbound",
  });
}

function resolveOutboundMessageId(result: unknown): string {
  return typeof result === "object" && result && "key" in result
    ? String((result as { key?: { id?: string } }).key?.id ?? "unknown")
    : "unknown";
}

export function createWebSendApi(params: {
  sock: {
    sendMessage: (jid: string, content: AnyMessageContent) => Promise<unknown>;
    sendPresenceUpdate: (presence: WAPresence, jid?: string) => Promise<unknown>;
  };
  defaultAccountId: string;
  lidLookup?: MentionLidLookup;
  getParticipants?: () => ParticipantMentionInfo[];
}) {
  const resolveMentions = async (text: string) => {
    const participants = params.getParticipants?.() ?? [];
    return resolveMentionJids(text, { lidLookup: params.lidLookup, participants });
  };

  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      sendOptions?: ActiveWebSendOptions,
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const mentionJids = await resolveMentions(text);
      const outgoingText = injectMentionTokens(text, mentionJids);
      const mentionPayload = mentionJids.length > 0 ? { mentions: mentionJids } : undefined;

      let payload: AnyMessageContent;
      if (mediaBuffer && mediaType) {
        if (mediaType.startsWith("image/")) {
          payload = {
            image: mediaBuffer,
            caption: outgoingText || undefined,
            mimetype: mediaType,
            ...mentionPayload,
          };
        } else if (mediaType.startsWith("audio/")) {
          payload = { audio: mediaBuffer, ptt: true, mimetype: mediaType };
        } else if (mediaType.startsWith("video/")) {
          const gifPlayback = sendOptions?.gifPlayback;
          payload = {
            video: mediaBuffer,
            caption: outgoingText || undefined,
            mimetype: mediaType,
            ...(gifPlayback ? { gifPlayback: true } : {}),
            ...mentionPayload,
          };
        } else {
          const fileName = sendOptions?.fileName?.trim() || "file";
          payload = {
            document: mediaBuffer,
            fileName,
            caption: outgoingText || undefined,
            mimetype: mediaType,
            ...mentionPayload,
          };
        }
      } else {
        payload = { text: outgoingText, ...mentionPayload };
      }
      const result = await params.sock.sendMessage(jid, payload);
      const accountId = sendOptions?.accountId ?? params.defaultAccountId;
      recordWhatsAppOutbound(accountId);
      const messageId = resolveOutboundMessageId(result);
      return { messageId };
    },
    sendPoll: async (
      to: string,
      poll: { question: string; options: string[]; maxSelections?: number },
    ): Promise<{ messageId: string }> => {
      const jid = toWhatsappJid(to);
      const result = await params.sock.sendMessage(jid, {
        poll: {
          name: poll.question,
          values: poll.options,
          selectableCount: poll.maxSelections ?? 1,
        },
      } as AnyMessageContent);
      recordWhatsAppOutbound(params.defaultAccountId);
      const messageId = resolveOutboundMessageId(result);
      return { messageId };
    },
    sendReaction: async (
      chatJid: string,
      messageId: string,
      emoji: string,
      fromMe: boolean,
      participant?: string,
    ): Promise<void> => {
      const jid = toWhatsappJid(chatJid);
      await params.sock.sendMessage(jid, {
        react: {
          text: emoji,
          key: {
            remoteJid: jid,
            id: messageId,
            fromMe,
            participant: participant ? toWhatsappJid(participant) : undefined,
          },
        },
      } as AnyMessageContent);
    },
    sendComposingTo: async (to: string): Promise<void> => {
      const jid = toWhatsappJid(to);
      await params.sock.sendPresenceUpdate("composing", jid);
    },
  } as const;
}
