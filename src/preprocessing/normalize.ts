import type { Conversation } from '../domain/conversation.js';

/**
 * Collapses whitespace and trims. Any run of whitespace (spaces, tabs, newlines)
 * becomes a single space. Broken encoding (mojibake) is deliberately left as-is:
 * the prompt instructs the model to tolerate it rather than have preprocessing
 * guess at a "fix" (R3).
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes every message's content, preserving roles, timestamps, and
 * conversation-level fields. Empty messages are not dropped here — whether a
 * conversation is evaluable is decided by the evaluability check (R2).
 */
export function normalizeConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      content: normalizeText(message.content),
    })),
  };
}
