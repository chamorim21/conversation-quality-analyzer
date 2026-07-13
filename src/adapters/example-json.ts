import { z } from 'zod';
import type { Conversation, Message, MessageRole } from '../domain/conversation.js';

/**
 * Raw shape of the sample dataset shipped with the challenge: an array of
 * sessions, each with an id and a list of role-prefixed strings
 * (`"human: ..."` / `"ai: ..."`). Kept separate from the canonical contract so
 * new external formats (e.g. voice transcripts) enter as new adapters without
 * touching the core.
 */
export const ExampleConversationSchema = z.object({
  sessionId: z.string(),
  messages: z.array(z.string()),
});
export type ExampleConversation = z.infer<typeof ExampleConversationSchema>;

export const ExampleFileSchema = z.array(ExampleConversationSchema);

/**
 * Maps the sample-format role prefix to a canonical role. `human` is the
 * `customer`; `ai` is the `attendant` (the bot "Beatriz" in the examples).
 */
const ROLE_BY_PREFIX: Record<string, MessageRole> = {
  human: 'customer',
  ai: 'attendant',
};

/**
 * Thrown when a sample message cannot be mapped to a canonical message —
 * missing role separator or an unrecognized role prefix. Conversion is never
 * silent: an unparseable message is surfaced, not dropped.
 */
export class MalformedExampleMessageError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly index: number,
    public readonly rawMessage: string,
  ) {
    super(
      `Malformed message at index ${index} of session "${sessionId}": ` +
        `expected a "human:" or "ai:" prefix, got ${JSON.stringify(rawMessage)}`,
    );
    this.name = 'MalformedExampleMessageError';
  }
}

/**
 * Parses a single `"human: ..."` / `"ai: ..."` string into a canonical message.
 * Splits on the first colon only, so colons inside the content (e.g.
 * `"Reposta da mensagem: ..."`) are preserved. Content is kept intact apart from
 * the single delimiter whitespace after the prefix; text normalization is a
 * later, separate preprocessing step.
 */
function parseExampleMessage(raw: string, sessionId: string, index: number): Message {
  const separator = raw.indexOf(':');
  if (separator === -1) {
    throw new MalformedExampleMessageError(sessionId, index, raw);
  }

  const prefix = raw.slice(0, separator).trim().toLowerCase();
  const role = ROLE_BY_PREFIX[prefix];
  if (!role) {
    throw new MalformedExampleMessageError(sessionId, index, raw);
  }

  const content = raw.slice(separator + 1).replace(/^\s/, '');
  return { role, content };
}

/**
 * Converts one sample-format session into a canonical {@link Conversation},
 * carrying over the `sessionId`. Validates the raw shape with Zod first, then
 * maps every message. Throws {@link MalformedExampleMessageError} on any message
 * that lacks a recognizable role prefix.
 */
export function adaptExampleConversation(input: unknown): Conversation {
  const raw = ExampleConversationSchema.parse(input);
  const messages = raw.messages.map((message, index) =>
    parseExampleMessage(message, raw.sessionId, index),
  );
  return { sessionId: raw.sessionId, messages };
}

/**
 * Converts the whole sample dataset (array of sessions) into canonical
 * conversations. Used by the demo script and by test fixtures.
 */
export function adaptExampleFile(input: unknown): Conversation[] {
  return ExampleFileSchema.parse(input).map(adaptExampleConversation);
}
