import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import {
  adaptExampleConversation,
  adaptExampleFile,
  MalformedExampleMessageError,
} from '../../src/adapters/example-json.js';
import type { Conversation } from '../../src/domain/conversation.js';

const examplesJson = readFileSync(new URL('../../data/examples.json', import.meta.url), 'utf8');
const examples = JSON.parse(examplesJson) as unknown;

describe('adaptExampleConversation', () => {
  it('maps human -> customer and ai -> attendant, preserving content', () => {
    const conversation = adaptExampleConversation({
      sessionId: 'S_1',
      messages: ['human: Eu sou Pessoa_001', 'ai: Olá, Pessoa_001'],
    });
    expect(conversation).toEqual({
      sessionId: 'S_1',
      messages: [
        { role: 'customer', content: 'Eu sou Pessoa_001' },
        { role: 'attendant', content: 'Olá, Pessoa_001' },
      ],
    } satisfies Conversation);
  });

  it('splits on the first colon so embedded system prefixes are preserved', () => {
    const conversation = adaptExampleConversation({
      sessionId: 'S_1',
      messages: ['human: Reposta da mensagem:  Entendi seu interesse'],
    });
    expect(conversation.messages[0]).toEqual({
      role: 'customer',
      content: 'Reposta da mensagem:  Entendi seu interesse',
    });
  });

  it('only strips the single delimiter space, keeping the rest of the content', () => {
    const conversation = adaptExampleConversation({
      sessionId: 'S_1',
      messages: ['ai:   três espaços à frente'],
    });
    expect(conversation.messages[0].content).toBe('  três espaços à frente');
  });

  it('is case-insensitive on the role prefix', () => {
    const conversation = adaptExampleConversation({
      sessionId: 'S_1',
      messages: ['Human: oi', 'AI: olá'],
    });
    expect(conversation.messages.map((m) => m.role)).toEqual(['customer', 'attendant']);
  });

  it('throws on an unrecognized role prefix instead of converting silently', () => {
    expect(() =>
      adaptExampleConversation({ sessionId: 'S_1', messages: ['system: reset'] }),
    ).toThrow(MalformedExampleMessageError);
  });

  it('throws on a message without a role separator', () => {
    try {
      adaptExampleConversation({ sessionId: 'S_1', messages: ['no prefix here'] });
      throw new Error('expected a MalformedExampleMessageError');
    } catch (error) {
      expect(error).toBeInstanceOf(MalformedExampleMessageError);
      expect((error as MalformedExampleMessageError).index).toBe(0);
      expect((error as MalformedExampleMessageError).sessionId).toBe('S_1');
    }
  });

  it('rejects a raw entry that is not the expected shape with a ZodError', () => {
    expect(() => adaptExampleConversation({ sessionId: 'S_1' })).toThrow(ZodError);
  });
});

describe('adaptExampleFile (data/examples.json fixture)', () => {
  it('loads the 20 challenge conversations', () => {
    const conversations = adaptExampleFile(examples);
    expect(conversations).toHaveLength(20);
  });

  it('maps every message to a canonical role with non-empty session ids', () => {
    const conversations = adaptExampleFile(examples);
    for (const conversation of conversations) {
      expect(conversation.sessionId).toMatch(/^S_/);
      expect(conversation.messages.length).toBeGreaterThan(0);
      for (const message of conversation.messages) {
        expect(['customer', 'attendant']).toContain(message.role);
      }
    }
  });

  it('includes the SPEC sanity-check sessions', () => {
    const ids = adaptExampleFile(examples).map((c) => c.sessionId);
    expect(ids).toEqual(
      expect.arrayContaining(['S_84b564f9', 'S_5ee36f40', 'S_213f6505', 'S_68c0d237']),
    );
  });
});
