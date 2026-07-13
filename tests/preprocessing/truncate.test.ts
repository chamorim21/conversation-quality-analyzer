import { describe, it, expect } from 'vitest';
import {
  truncateConversation,
  type PreparedMessage,
  type OmissionMarker,
} from '../../src/preprocessing/truncate.js';
import type { Conversation } from '../../src/domain/conversation.js';

/** Deterministic counter: every message costs a fixed 10 tokens, so budgets are
 * easy to reason about without loading the real tokenizer. */
const constCounter = () => 10;

function makeConversation(count: number): Conversation {
  return {
    sessionId: 'S_1',
    channel: 'whatsapp',
    messages: Array.from({ length: count }, (_unused, i) => ({
      role: i % 2 === 0 ? ('customer' as const) : ('attendant' as const),
      content: `message ${i}`,
    })),
  };
}

describe('truncateConversation', () => {
  it('passes through untouched when under the token budget', () => {
    const conversation = makeConversation(4);
    const result = truncateConversation(conversation, {
      maxTokens: 1000,
      countTokens: constCounter,
    });

    expect(result.truncated).toBe(false);
    expect(result.omittedMessageCount).toBe(0);
    expect(result.entries).toHaveLength(4);
    expect(result.entries.every((e) => e.kind === 'message')).toBe(true);
    expect((result.entries as PreparedMessage[]).map((e) => e.originalIndex)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(result.sessionId).toBe('S_1');
    expect(result.channel).toBe('whatsapp');
  });

  it('keeps head and tail and inserts an omission marker when over budget', () => {
    // 6 messages * 10 = 60 tokens; budget = 30 - 16 marker reserve = 14.
    const result = truncateConversation(makeConversation(6), {
      maxTokens: 30,
      countTokens: constCounter,
    });

    expect(result.truncated).toBe(true);
    expect(result.omittedMessageCount).toBe(4);
    expect(result.entries).toHaveLength(3);

    const [head, marker, tail] = result.entries;
    expect(head.kind).toBe('message');
    expect((head as PreparedMessage).originalIndex).toBe(0);
    expect(tail.kind).toBe('message');
    expect((tail as PreparedMessage).originalIndex).toBe(5);

    expect(marker.kind).toBe('omission');
    expect((marker as OmissionMarker).omittedCount).toBe(4);
    expect((marker as OmissionMarker).text).toBe('[... 4 mensagens omitidas ...]');
  });

  it('balances head and tail, preserving original indices on remaining messages', () => {
    // 6 messages * 10 = 60; budget = 59 - 16 = 43 → keeps two from each end.
    const result = truncateConversation(makeConversation(6), {
      maxTokens: 59,
      countTokens: constCounter,
    });

    expect(result.truncated).toBe(true);
    expect(result.omittedMessageCount).toBe(2);

    const kinds = result.entries.map((e) => e.kind);
    expect(kinds).toEqual(['message', 'message', 'omission', 'message', 'message']);

    const indices = result.entries
      .filter((e): e is PreparedMessage => e.kind === 'message')
      .map((e) => e.originalIndex);
    expect(indices).toEqual([0, 1, 4, 5]);
  });

  it('never splits or edits message content', () => {
    const result = truncateConversation(makeConversation(6), {
      maxTokens: 30,
      countTokens: constCounter,
    });
    const contents = result.entries
      .filter((e): e is PreparedMessage => e.kind === 'message')
      .map((e) => e.content);
    expect(contents).toEqual(['message 0', 'message 5']);
  });

  it('uses the real tokenizer by default for a short conversation', () => {
    const result = truncateConversation(makeConversation(3), { maxTokens: 30_000 });
    expect(result.truncated).toBe(false);
    expect(result.entries).toHaveLength(3);
  });
});
