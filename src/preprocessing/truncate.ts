import { getEncoding, type Tiktoken } from 'js-tiktoken';
import type { Channel, Conversation, MessageRole } from '../domain/conversation.js';

/**
 * A message that remembers its position in the original, pre-truncation
 * conversation. Keeping the original index means cited evidence (R5) keeps
 * pointing at the right message even after the middle is dropped.
 */
export interface PreparedMessage {
  kind: 'message';
  originalIndex: number;
  role: MessageRole;
  content: string;
  timestamp?: string;
}

/** Marker standing in for the messages dropped by head+tail truncation. */
export interface OmissionMarker {
  kind: 'omission';
  omittedCount: number;
  text: string;
}

export type PreparedEntry = PreparedMessage | OmissionMarker;

/**
 * A conversation ready for prompt rendering. When `truncated`, `entries` holds a
 * head slice, one {@link OmissionMarker}, then a tail slice; otherwise it holds
 * every message. `omittedMessageCount` is 0 when nothing was dropped.
 */
export interface PreparedConversation {
  sessionId?: string;
  channel?: Channel;
  entries: PreparedEntry[];
  truncated: boolean;
  omittedMessageCount: number;
}

/** Counts the tokens in a piece of text. Injectable so tests stay deterministic
 * and offline. */
export type TokenCounter = (text: string) => number;

export interface TruncateOptions {
  maxTokens: number;
  /** Defaults to the gpt-4o-mini (`o200k_base`) encoder. */
  countTokens?: TokenCounter;
}

/** Rough token budget reserved for the omission marker line. */
const MARKER_TOKEN_RESERVE = 16;

let encoder: Tiktoken | undefined;

/** Default token counter using the `o200k_base` encoding (gpt-4o / gpt-4o-mini).
 * The encoder is created lazily and reused. */
export function countTokensDefault(text: string): number {
  encoder ??= getEncoding('o200k_base');
  return encoder.encode(text).length;
}

function omissionText(count: number): string {
  return `[... ${count} mensagens omitidas ...]`;
}

function toPreparedMessage(
  message: Conversation['messages'][number],
  originalIndex: number,
): PreparedMessage {
  return {
    kind: 'message',
    originalIndex,
    role: message.role,
    content: message.content,
    ...(message.timestamp !== undefined ? { timestamp: message.timestamp } : {}),
  };
}

/**
 * Truncates a conversation to fit `maxTokens` (R3). Below the budget the
 * conversation passes through untouched. Above it, messages are kept greedily
 * from both ends — alternating head and tail so the opening (the customer's
 * goal) and the closing (the resolution) are both preserved — and the dropped
 * middle is replaced by a single omission marker. Message content is never
 * edited or split; truncation is message-granular. Original indices are
 * preserved on every kept message.
 */
export function truncateConversation(
  conversation: Conversation,
  options: TruncateOptions,
): PreparedConversation {
  const { maxTokens, countTokens = countTokensDefault } = options;
  const messages = conversation.messages;

  const base: Pick<PreparedConversation, 'sessionId' | 'channel'> = {
    ...(conversation.sessionId !== undefined ? { sessionId: conversation.sessionId } : {}),
    ...(conversation.channel !== undefined ? { channel: conversation.channel } : {}),
  };

  const tokenCost = messages.map((m) => countTokens(`${m.role}: ${m.content}`));
  const total = tokenCost.reduce((sum, n) => sum + n, 0);

  if (total <= maxTokens) {
    return {
      ...base,
      entries: messages.map((message, index) => toPreparedMessage(message, index)),
      truncated: false,
      omittedMessageCount: 0,
    };
  }

  // Alternate taking from the front and the back until the next message would
  // exceed the budget (leaving room for the marker). At least one head and one
  // tail message are always kept.
  const budget = Math.max(0, maxTokens - MARKER_TOKEN_RESERVE);
  let used = 0;
  let head = 0;
  let tail = 0;
  let takeFromHead = true;
  let low = 0;
  let high = messages.length - 1;

  while (low <= high) {
    const index = takeFromHead ? low : high;
    const cost = tokenCost[index];
    const mustKeep =
      (takeFromHead && head === 0) || (!takeFromHead && tail === 0);
    if (!mustKeep && used + cost > budget) break;

    used += cost;
    if (takeFromHead) {
      head += 1;
      low += 1;
    } else {
      tail += 1;
      high += -1;
    }
    takeFromHead = !takeFromHead;
  }

  const omittedMessageCount = messages.length - head - tail;

  // Nothing could be dropped (e.g. one or two messages that individually exceed
  // the budget). Pass through untouched rather than emit an empty marker.
  if (omittedMessageCount <= 0) {
    return {
      ...base,
      entries: messages.map((message, index) => toPreparedMessage(message, index)),
      truncated: false,
      omittedMessageCount: 0,
    };
  }

  const entries: PreparedEntry[] = [];

  for (let i = 0; i < head; i += 1) {
    entries.push(toPreparedMessage(messages[i], i));
  }
  entries.push({
    kind: 'omission',
    omittedCount: omittedMessageCount,
    text: omissionText(omittedMessageCount),
  });
  for (let i = messages.length - tail; i < messages.length; i += 1) {
    entries.push(toPreparedMessage(messages[i], i));
  }

  return {
    ...base,
    entries,
    truncated: true,
    omittedMessageCount,
  };
}
