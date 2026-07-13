import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { adaptCanonicalConversation } from '../../src/adapters/canonical.js';

describe('adaptCanonicalConversation', () => {
  it('passes through a valid canonical conversation', () => {
    const input = {
      sessionId: 'S_1',
      channel: 'whatsapp',
      messages: [
        { role: 'customer', content: 'oi' },
        { role: 'attendant', content: 'olá', timestamp: '2024-01-01T00:00:00Z' },
      ],
    };
    expect(adaptCanonicalConversation(input)).toEqual(input);
  });

  it('accepts a conversation without the optional fields', () => {
    const input = { messages: [{ role: 'customer', content: 'oi' }] };
    expect(adaptCanonicalConversation(input)).toEqual(input);
  });

  it('rejects an unknown role with a ZodError', () => {
    const input = { messages: [{ role: 'agent', content: 'oi' }] };
    expect(() => adaptCanonicalConversation(input)).toThrow(ZodError);
  });

  it('rejects a missing messages array with a ZodError', () => {
    expect(() => adaptCanonicalConversation({ sessionId: 'S_1' })).toThrow(ZodError);
  });

  it('surfaces field-level details on invalid input', () => {
    try {
      adaptCanonicalConversation({ messages: [{ role: 'customer' }] });
      throw new Error('expected a ZodError');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues[0].path).toEqual(['messages', 0, 'content']);
    }
  });
});
