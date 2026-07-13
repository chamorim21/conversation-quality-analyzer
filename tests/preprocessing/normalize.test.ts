import { describe, it, expect } from 'vitest';
import { normalizeText, normalizeConversation } from '../../src/preprocessing/normalize.js';
import type { Conversation } from '../../src/domain/conversation.js';

describe('normalizeText', () => {
  it('trims and collapses whitespace runs to a single space', () => {
    expect(normalizeText('  hello   world  ')).toBe('hello world');
    expect(normalizeText('line1\n\n\tline2')).toBe('line1 line2');
  });

  it('leaves already-clean text unchanged', () => {
    expect(normalizeText('bom dia')).toBe('bom dia');
  });

  it('does not attempt to repair mojibake', () => {
    const mojibake = 'atenÃ§Ã£o';
    expect(normalizeText(`  ${mojibake}  `)).toBe(mojibake);
  });

  it('reduces whitespace-only content to an empty string', () => {
    expect(normalizeText('   \n\t ')).toBe('');
  });
});

describe('normalizeConversation', () => {
  it('normalizes every message content and preserves other fields', () => {
    const conversation: Conversation = {
      sessionId: 'S_1',
      channel: 'whatsapp',
      messages: [
        { role: 'customer', content: '  oi  ', timestamp: '2024-01-01' },
        { role: 'attendant', content: 'olá,\n como posso   ajudar?' },
      ],
    };

    expect(normalizeConversation(conversation)).toEqual({
      sessionId: 'S_1',
      channel: 'whatsapp',
      messages: [
        { role: 'customer', content: 'oi', timestamp: '2024-01-01' },
        { role: 'attendant', content: 'olá, como posso ajudar?' },
      ],
    });
  });

  it('does not drop messages that become empty', () => {
    const conversation: Conversation = {
      messages: [{ role: 'customer', content: '   ' }],
    };
    expect(normalizeConversation(conversation).messages).toHaveLength(1);
    expect(normalizeConversation(conversation).messages[0].content).toBe('');
  });
});
