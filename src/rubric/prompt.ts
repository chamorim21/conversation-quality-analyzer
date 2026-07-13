import type { Conversation } from '../domain/conversation.js';
import { ANCHOR_LEVELS, type Rubric } from './schema.js';

/**
 * Version identifier of the prompt template. Bump whenever the wording or
 * structure below changes; it is persisted in the audit trail so past
 * evaluations remain reproducible.
 */
export const PROMPT_VERSION = 'v1';

/**
 * Builds the system prompt from a rubric. The dimensions, anchors, and flags
 * are rendered from the rubric, so adding a criterion to the YAML makes it
 * appear here with no code change. Written in Portuguese by design (R5); the
 * rubric itself is language-agnostic.
 */
export function buildSystemPrompt(rubric: Rubric): string {
  const dimensions = rubric.dimensions
    .map((dimension) => {
      const anchors = ANCHOR_LEVELS.map(
        (level) => `    ${level}: ${dimension.anchors[level]}`,
      ).join('\n');
      return `- ${dimension.name} (id: ${dimension.id}): ${dimension.description}\n  Âncoras de nota:\n${anchors}`;
    })
    .join('\n\n');

  const flags = rubric.flags.length
    ? rubric.flags.map((flag) => `- ${flag.id}: ${flag.description}`).join('\n')
    : '(nenhuma)';

  return [
    'Você é um avaliador especialista em qualidade de atendimento ao cliente. Avalie a conversa entre um cliente e um atendente (humano ou bot) de forma objetiva, criteriosa e imparcial, baseando-se exclusivamente no que está na conversa.',

    'Dimensões a avaliar (atribua a cada uma uma nota inteira de 0 a 5, usando as âncoras como referência):\n\n' +
      dimensions,

    'Flags críticas (marque como disparada apenas quando houver evidência clara na conversa):\n' +
      flags,

    [
      'Instruções de avaliação:',
      '- Para cada dimensão, forneça: a nota (0 a 5), uma justificativa objetiva e evidências.',
      '- Evidências devem ser trechos LITERAIS da conversa, cada um acompanhado do índice (0-based) da mensagem de onde foi extraído.',
      '- Quando não houver evidência suficiente para avaliar uma dimensão, marque-a como insufficient_data (com nota nula) em vez de adivinhar.',
      '- Mensagens de sistema embutidas no texto (por exemplo, prefixos como "Reposta da mensagem: ..." ou descrições de imagem) são contexto do canal, NÃO falhas do atendente; não penalize por elas.',
      '- Texto com caracteres corrompidos (mojibake/encoding quebrado) não deve ser penalizado nem "corrigido"; avalie o conteúdo pretendido.',
      '- Não invente informações que não estejam na conversa.',
      '- Ao final, escreva um resumo executivo em português.',
      '- Responda estritamente no formato estruturado solicitado.',
    ].join('\n'),
  ].join('\n\n');
}

/**
 * Renders the user prompt: the conversation with each message prefixed by its
 * index, so the model can cite evidence by index.
 */
export function buildUserPrompt(conversation: Conversation): string {
  const header = `Sessão: ${conversation.sessionId ?? '(sem id)'}`;
  const lines = conversation.messages.map(
    (message, index) => `[${index}] ${message.role}: ${message.content}`,
  );
  return `${header}\n\nConversa:\n${lines.join('\n')}`;
}

/** Convenience bundle: prompt version plus system and user messages. */
export function renderPrompt(rubric: Rubric, conversation: Conversation) {
  return {
    promptVersion: PROMPT_VERSION,
    system: buildSystemPrompt(rubric),
    user: buildUserPrompt(conversation),
  };
}
