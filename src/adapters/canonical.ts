import { ConversationSchema, type Conversation } from '../domain/conversation.js';

/**
 * Adapter for input that already follows the canonical contract (R1). It is a
 * thin validation pass so every entry point produces a `Conversation` the same
 * way: parse against the canonical schema and let Zod reject anything malformed.
 *
 * Throws a `ZodError` (with field-level details) on invalid input; the API error
 * handler maps that to a `400`. Structural validation only — evaluability rules
 * (R2) run later in preprocessing.
 */
export function adaptCanonicalConversation(input: unknown): Conversation {
  return ConversationSchema.parse(input);
}
