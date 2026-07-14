import { describe, it, expect } from 'vitest';
import { parseRubric, type RubricDimension } from '../../src/rubric/schema.js';
import {
  buildSystemPrompt,
  buildUserPrompt,
  renderPrompt,
  PROMPT_VERSION,
} from '../../src/rubric/prompt.js';
import type { MessageRole } from '../../src/domain/conversation.js';
import type { PreparedConversation } from '../../src/preprocessing/truncate.js';

function anchors(): RubricDimension['anchors'] {
  return { '0': 'z', '1': 'o', '2': 'd', '3': 't', '4': 'q', '5': 'c' };
}

/** Builds a non-truncated {@link PreparedConversation} where each message keeps
 * its position as its original index. */
function prepared(
  messages: Array<{ role: MessageRole; content: string }>,
  sessionId?: string,
): PreparedConversation {
  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    entries: messages.map((message, index) => ({
      kind: 'message',
      originalIndex: index,
      role: message.role,
      content: message.content,
    })),
    truncated: false,
    omittedMessageCount: 0,
  };
}

function rubricWith(dimensions: RubricDimension[]) {
  return parseRubric({
    id: 'test',
    version: 1,
    dimensions,
    flags: [{ id: 'some_flag', description: 'flag de teste' }],
  });
}

const baseDimension: RubricDimension = {
  id: 'communication',
  name: 'Comunicação',
  description: 'Clareza das mensagens.',
  weight: 1.0,
  anchors: anchors(),
};

describe('buildSystemPrompt', () => {
  it('renders every dimension (id, name, description, anchors) and flags', () => {
    const prompt = buildSystemPrompt(rubricWith([baseDimension]));
    expect(prompt).toContain('Comunicação');
    expect(prompt).toContain('id: communication');
    expect(prompt).toContain('Clareza das mensagens.');
    expect(prompt).toContain('0: z');
    expect(prompt).toContain('5: c');
    expect(prompt).toContain('some_flag');
  });

  it('includes the required evaluation instructions', () => {
    const prompt = buildSystemPrompt(rubricWith([baseDimension]));
    expect(prompt).toMatch(/insufficient_data/);
    expect(prompt).toMatch(/índice/i);
    expect(prompt).toMatch(/mojibake/i);
    expect(prompt).toMatch(/Reposta da mensagem/);
    expect(prompt).toMatch(/resumo executivo/i);
  });

  it('a new dimension added to the rubric appears in the prompt without code change', () => {
    const extended = rubricWith([
      { ...baseDimension, weight: 0.5 },
      {
        id: 'tone_quality',
        name: 'Qualidade do tom',
        description: 'Tom cordial e profissional.',
        weight: 0.5,
        anchors: anchors(),
      },
    ]);
    const prompt = buildSystemPrompt(extended);
    expect(prompt).toContain('Qualidade do tom');
    expect(prompt).toContain('id: tone_quality');
  });
});

describe('buildUserPrompt', () => {
  it('prefixes each message with its 0-based index', () => {
    const user = buildUserPrompt(
      prepared(
        [
          { role: 'customer', content: 'olá' },
          { role: 'attendant', content: 'oi, tudo bem?' },
        ],
        'S_1',
      ),
    );
    expect(user).toContain('Sessão: S_1');
    expect(user).toContain('[0] customer: olá');
    expect(user).toContain('[1] attendant: oi, tudo bem?');
  });

  it('renders original indices and the omission marker for a truncated conversation', () => {
    const user = buildUserPrompt({
      entries: [
        { kind: 'message', originalIndex: 0, role: 'customer', content: 'primeira' },
        { kind: 'omission', omittedCount: 5, text: '[... 5 mensagens omitidas ...]' },
        { kind: 'message', originalIndex: 7, role: 'attendant', content: 'última' },
      ],
      truncated: true,
      omittedMessageCount: 5,
    });
    // Indices reflect the original positions, not the truncated array order.
    expect(user).toContain('[0] customer: primeira');
    expect(user).toContain('[... 5 mensagens omitidas ...]');
    expect(user).toContain('[7] attendant: última');
    expect(user).not.toContain('[1] attendant: última');
  });
});

describe('renderPrompt', () => {
  it('bundles the prompt version with system and user messages', () => {
    const result = renderPrompt(
      rubricWith([baseDimension]),
      prepared([{ role: 'customer', content: 'oi' }]),
    );
    expect(result.promptVersion).toBe(PROMPT_VERSION);
    expect(result.system).toContain('Comunicação');
    expect(result.user).toContain('[0] customer: oi');
  });
});
