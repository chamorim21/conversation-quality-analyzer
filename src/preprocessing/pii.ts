import type { Conversation } from '../domain/conversation.js';

/**
 * Regex-based PII masking applied before any text leaves the process for the LLM
 * (R3). This is best-effort by design (SPEC risk): only the listed formats are
 * covered, and NER is documented as a future improvement. Placeholders are fixed
 * and stable, so the same input always yields the same masked output.
 *
 * Order matters: more specific patterns run before greedier ones (email and the
 * dotted CPF before dates and phones) so a value is claimed by the right rule.
 */
interface PiiRule {
  pattern: RegExp;
  placeholder: string;
}

const RULES: PiiRule[] = [
  // Email.
  {
    pattern: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
    placeholder: '[EMAIL]',
  },
  // CPF in its canonical formatted form: 000.000.000-00.
  {
    pattern: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g,
    placeholder: '[CPF]',
  },
  // Dates: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (2- or 4-digit year) and ISO yyyy-mm-dd.
  {
    pattern: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g,
    placeholder: '[DATA]',
  },
  // Brazilian phone. To avoid masking ordinary numbers (order ids, year ranges,
  // quantities), a match must be phone-shaped: either an area code (optionally in
  // parentheses, optionally with a +55 country code) followed by a *separated*
  // local number, or a bare 10–11 digit run (DDD + number typed without spaces).
  // A dash-only local number such as 3456-7890 is intentionally not matched — it
  // is indistinguishable from a numeric range like 2020-2024.
  {
    pattern: /(?:\+55[\s-]?)?\(?\d{2}\)?[\s-]\d{4,5}[\s-]?\d{4}\b|\b\d{10,11}\b/g,
    placeholder: '[TELEFONE]',
  },
];

/** Masks known PII formats in a string, returning a stable masked copy. */
export function maskPii(text: string): string {
  return RULES.reduce(
    (masked, rule) => masked.replace(rule.pattern, rule.placeholder),
    text,
  );
}

/** Masks PII in every message's content, preserving everything else. */
export function maskConversation(conversation: Conversation): Conversation {
  return {
    ...conversation,
    messages: conversation.messages.map((message) => ({
      ...message,
      content: maskPii(message.content),
    })),
  };
}
