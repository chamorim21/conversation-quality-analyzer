import { describe, it, expect } from 'vitest';
import { assertEvaluable, NotEvaluableError } from '../../src/preprocessing/evaluability.js';
import type { Conversation } from '../../src/domain/conversation.js';

describe('assertEvaluable', () => {
  it('passes a conversation with content from both roles', () => {
    const conversation: Conversation = {
      messages: [
        { role: 'customer', content: 'oi' },
        { role: 'attendant', content: 'olá' },
      ],
    };
    expect(() => assertEvaluable(conversation)).not.toThrow();
  });

  it('rejects an empty conversation', () => {
    expect(() => assertEvaluable({ messages: [] })).toThrow(NotEvaluableError);
    try {
      assertEvaluable({ messages: [] });
    } catch (error) {
      expect((error as NotEvaluableError).reason).toBe('conversation has no messages');
    }
  });

  it('rejects when there is no customer message', () => {
    const conversation: Conversation = {
      messages: [{ role: 'attendant', content: 'olá' }],
    };
    expect(() => assertEvaluable(conversation)).toThrow(/no customer message/);
  });

  it('rejects when there is no attendant message', () => {
    const conversation: Conversation = {
      messages: [{ role: 'customer', content: 'oi' }],
    };
    expect(() => assertEvaluable(conversation)).toThrow(/no attendant message/);
  });

  it('rejects when a role is present only with empty content', () => {
    const conversation: Conversation = {
      messages: [
        { role: 'customer', content: 'oi' },
        { role: 'attendant', content: '   ' },
      ],
    };
    expect(() => assertEvaluable(conversation)).toThrow(/no attendant message/);
  });
});
