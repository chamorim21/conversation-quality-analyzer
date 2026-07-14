import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { parseRubric, type RubricDimension } from '../../src/rubric/schema.js';
import { MockLlmClient } from '../../src/evaluation/llm-client.js';
import { evaluateConversation } from '../../src/evaluation/orchestrator.js';
import type { Conversation } from '../../src/domain/conversation.js';

function anchors(): RubricDimension['anchors'] {
  return { '0': 'z', '1': 'o', '2': 'd', '3': 't', '4': 'q', '5': 'c' };
}

const rubric = parseRubric({
  id: 'test',
  version: 1,
  dimensions: [
    {
      id: 'communication',
      name: 'Comunicação',
      description: 'Clareza.',
      weight: 0.5,
      anchors: anchors(),
    },
    {
      id: 'resolution',
      name: 'Resolutividade',
      description: 'Conduz ao objetivo.',
      weight: 0.5,
      anchors: anchors(),
    },
  ],
  flags: [{ id: 'hallucination', description: 'Inventou informação.' }],
});

const conversation: Conversation = {
  sessionId: 'S_1',
  messages: [
    { role: 'customer', content: 'quero informações' },
    { role: 'attendant', content: 'claro, posso ajudar' },
  ],
};

function validRaw() {
  return {
    dimensions: {
      communication: {
        insufficient_data: false,
        score: 4,
        justification: 'clara',
        evidence: [{ message_index: 1, quote: 'claro, posso ajudar' }],
      },
      resolution: {
        insufficient_data: false,
        score: 2,
        justification: 'parcial',
        evidence: [],
      },
    },
    flags: {
      hallucination: { triggered: false, justification: 'sem sinais', evidence: [] },
    },
    summary: 'Atendimento razoável.',
  };
}

describe('evaluateConversation', () => {
  it('maps the LLM response to domain results and aggregates the overall score', async () => {
    const client = new MockLlmClient(() => ({ raw: validRaw(), tokensIn: 100, tokensOut: 20 }));

    const output = await evaluateConversation({
      client,
      rubric,
      conversation,
      model: 'gpt-4o-mini',
    });

    expect(output.result.dimensions).toEqual([
      {
        dimensionId: 'communication',
        score: 4,
        justification: 'clara',
        evidence: [{ messageIndex: 1, quote: 'claro, posso ajudar' }],
      },
      { dimensionId: 'resolution', score: 2, justification: 'parcial', evidence: [] },
    ]);
    expect(output.result.flags).toEqual([
      { flagId: 'hallucination', triggered: false, justification: 'sem sinais', evidence: [] },
    ]);
    expect(output.result.overallScore).toBe(3); // (4 + 2) / 2
    expect(output.result.summary).toBe('Atendimento razoável.');
  });

  it('maps insufficient_data to a null score excluded from aggregation', async () => {
    const client = new MockLlmClient(() => {
      const body = validRaw();
      body.dimensions.resolution = {
        insufficient_data: true,
        score: null,
        justification: 'sem evidência',
        evidence: [],
      } as never;
      return { raw: body };
    });

    const output = await evaluateConversation({
      client,
      rubric,
      conversation,
      model: 'gpt-4o-mini',
    });

    expect(output.result.dimensions[1].score).toBeNull();
    expect(output.result.overallScore).toBe(4); // only communication counts
  });

  it('returns the rendered prompt, raw response and usage for the audit trail', async () => {
    const client = new MockLlmClient(() => ({ raw: validRaw(), tokensIn: 100, tokensOut: 20 }));

    const output = await evaluateConversation({
      client,
      rubric,
      conversation,
      model: 'gpt-4o-mini',
    });

    expect(output.promptVersion).toBe('v1');
    expect(output.renderedPrompt.system).toContain('Comunicação');
    expect(output.renderedPrompt.user).toContain('[0] customer: quero informações');
    expect(output.rawResponse).toEqual(validRaw());
    expect(output.tokensIn).toBe(100);
    expect(output.tokensOut).toBe(20);
    expect(output.retries).toBe(0);
  });

  it('sends a strict rubric-derived schema and rejects an out-of-schema response', async () => {
    const client = new MockLlmClient((req) => {
      // The orchestrator must ask for both dimensions and the flag by id.
      const schema = req.schema as {
        properties: { dimensions: { required: string[] }; flags: { required: string[] } };
      };
      expect(schema.properties.dimensions.required).toEqual(['communication', 'resolution']);
      expect(schema.properties.flags.required).toEqual(['hallucination']);
      return { raw: { dimensions: {}, flags: {}, summary: 'x' } };
    });

    await expect(
      evaluateConversation({ client, rubric, conversation, model: 'gpt-4o-mini' }),
    ).rejects.toBeInstanceOf(z.ZodError);
  });
});
