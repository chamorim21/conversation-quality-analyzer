import type { Conversation } from '../domain/conversation.js';

/**
 * Thrown when a conversation fails the deterministic pre-LLM evaluability rules
 * (R2). Carries a human-readable `reason` so the API can surface it in a 422
 * without sending anything to the LLM.
 */
export class NotEvaluableError extends Error {
  constructor(public readonly reason: string) {
    super(`Conversation is not evaluable: ${reason}`);
    this.name = 'NotEvaluableError';
  }
}

function hasRoleWithContent(
  conversation: Conversation,
  role: Conversation['messages'][number]['role'],
): boolean {
  return conversation.messages.some(
    (message) => message.role === role && message.content.trim().length > 0,
  );
}

/**
 * Enforces the evaluability rules (R2): the conversation must contain at least
 * one `attendant` and one `customer` message, each with non-empty content after
 * normalization. Throws {@link NotEvaluableError} otherwise. Expects an
 * already-normalized conversation.
 */
export function assertEvaluable(conversation: Conversation): void {
  if (conversation.messages.length === 0) {
    throw new NotEvaluableError('conversation has no messages');
  }
  if (!hasRoleWithContent(conversation, 'customer')) {
    throw new NotEvaluableError('no customer message with content');
  }
  if (!hasRoleWithContent(conversation, 'attendant')) {
    throw new NotEvaluableError('no attendant message with content');
  }
}
