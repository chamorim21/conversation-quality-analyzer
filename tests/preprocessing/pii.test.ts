import { describe, it, expect } from 'vitest';
import { maskPii, maskConversation } from '../../src/preprocessing/pii.js';
import type { Conversation } from '../../src/domain/conversation.js';

describe('maskPii', () => {
  it('masks a formatted CPF', () => {
    expect(maskPii('meu cpf é 123.456.789-09, ok?')).toBe('meu cpf é [CPF], ok?');
  });

  it('masks email addresses', () => {
    expect(maskPii('escreva para joao.silva@example.com.br')).toBe(
      'escreva para [EMAIL]',
    );
  });

  it('masks Brazilian phone numbers in several formats', () => {
    expect(maskPii('ligue (11) 98765-4321')).toBe('ligue [TELEFONE]');
    expect(maskPii('meu número é +55 11 3456-7890')).toBe('meu número é [TELEFONE]');
    expect(maskPii('whatsapp 11987654321')).toBe('whatsapp [TELEFONE]');
  });

  it('masks dates', () => {
    expect(maskPii('nasci em 05/12/1990')).toBe('nasci em [DATA]');
    expect(maskPii('data 1990-12-05')).toBe('data [DATA]');
    expect(maskPii('em 5.12.90')).toBe('em [DATA]');
  });

  it('is deterministic: same input yields same output', () => {
    const input = 'cpf 123.456.789-09 e email a@b.com';
    expect(maskPii(input)).toBe(maskPii(input));
    expect(maskPii(input)).toBe('cpf [CPF] e email [EMAIL]');
  });

  it('does not mask ordinary text or short numbers (no false positives)', () => {
    expect(maskPii('o curso custa R$ 199,90')).toBe('o curso custa R$ 199,90');
    expect(maskPii('tenho 3 gatos e nota 5')).toBe('tenho 3 gatos e nota 5');
    expect(maskPii('sala 204, andar 12')).toBe('sala 204, andar 12');
  });

  it('does not mask numeric text that merely looks phone-ish', () => {
    // 8-digit ids, protocols and year ranges are not phone-shaped.
    expect(maskPii('pedido numero 12345678')).toBe('pedido numero 12345678');
    expect(maskPii('referencia 87654321')).toBe('referencia 87654321');
    expect(maskPii('protocolo 3456 7890')).toBe('protocolo 3456 7890');
    expect(maskPii('entre 2020 2024 cresceu')).toBe('entre 2020 2024 cresceu');
    expect(maskPii('faturamento 2020-2024')).toBe('faturamento 2020-2024');
  });

  it('masks a bare 10–11 digit number (phone or unformatted CPF) as PII', () => {
    // Best-effort: a bare 11-digit CPF is still masked (as [TELEFONE]); privacy is
    // preserved even though the label is not the precise one.
    expect(maskPii('numero 12345678909')).toBe('numero [TELEFONE]');
    expect(maskPii('ddd e numero 1133334444')).toBe('ddd e numero [TELEFONE]');
  });

  it('masks multiple PII occurrences in one string', () => {
    expect(maskPii('cpf 111.222.333-44 tel (21) 99999-8888')).toBe(
      'cpf [CPF] tel [TELEFONE]',
    );
  });
});

describe('maskConversation', () => {
  it('masks PII in every message and preserves structure', () => {
    const conversation: Conversation = {
      sessionId: 'S_1',
      messages: [
        { role: 'customer', content: 'meu cpf 123.456.789-09', timestamp: 't1' },
        { role: 'attendant', content: 'obrigado' },
      ],
    };

    expect(maskConversation(conversation)).toEqual({
      sessionId: 'S_1',
      messages: [
        { role: 'customer', content: 'meu cpf [CPF]', timestamp: 't1' },
        { role: 'attendant', content: 'obrigado' },
      ],
    });
  });
});
