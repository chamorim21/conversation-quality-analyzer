import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { adaptExampleFile } from '../src/adapters/example-json.js';
import type { Conversation } from '../src/domain/conversation.js';

/**
 * Demonstration script: evaluates conversations from `data/examples.json`
 * against a *running* API (real OpenAI), printing scores, triggered flags, cost
 * and latency per conversation. Start the server first (`npm run dev`), then:
 *
 *   npm run demo -- --session S_84b564f9          # one session
 *   npm run demo -- --session S_84b564f9 --session S_5ee36f40
 *   npm run demo                                  # all conversations
 *   npm run demo -- --rubric default@1 --model gpt-5.6-terra
 *
 * This is the real-time demonstration of the implemented (single-call) approach.
 */

const { values } = parseArgs({
  options: {
    session: { type: 'string', multiple: true },
    'base-url': { type: 'string' },
    rubric: { type: 'string' },
    model: { type: 'string' },
  },
});

const baseUrl =
  values['base-url'] ?? `http://localhost:${process.env.PORT ?? '3000'}`;

const examples = adaptExampleFile(
  JSON.parse(readFileSync(new URL('../data/examples.json', import.meta.url), 'utf8')),
);

const wanted = values.session;
const selected = wanted?.length
  ? examples.filter((c) => wanted.includes(c.sessionId ?? ''))
  : examples;

if (selected.length === 0) {
  console.error(
    wanted?.length
      ? `No matching sessions for: ${wanted.join(', ')}`
      : 'No conversations found in data/examples.json',
  );
  process.exit(1);
}

interface DimensionResult {
  dimensionId: string;
  score: number | null;
}
interface FlagResult {
  flagId: string;
  triggered: boolean;
}
interface EvaluationResponse {
  overallScore: number | null;
  dimensions: DimensionResult[];
  flags: FlagResult[];
  metadata: {
    costUsd: number;
    latencyMs: number;
    tokensIn: number;
    tokensOut: number;
    truncated: boolean;
    model: string;
  };
}

function fmtScore(score: number | null): string {
  return score === null ? 'n/a' : String(score);
}

async function evaluate(conversation: Conversation): Promise<EvaluationResponse> {
  const options: Record<string, string> = {};
  if (values.rubric) options.rubric = values.rubric;
  if (values.model) options.model = values.model;

  const response = await fetch(`${baseUrl}/evaluations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversation,
      ...(Object.keys(options).length ? { options } : {}),
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body as EvaluationResponse;
}

/** A failed `fetch` (server down, wrong URL) rejects with a TypeError whose
 * cause is a connection error — distinct from an HTTP error the API returned. */
function isConnectionError(error: unknown): boolean {
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

async function main(): Promise<void> {
  console.log(`Evaluating ${selected.length} conversation(s) against ${baseUrl}\n`);

  let totalCost = 0;
  let totalLatency = 0;
  let errors = 0;

  for (const conversation of selected) {
    const id = conversation.sessionId ?? '(no id)';
    try {
      const result = await evaluate(conversation);
      const scores = result.dimensions
        .map((d) => `${d.dimensionId}=${fmtScore(d.score)}`)
        .join('  ');
      const triggered = result.flags.filter((f) => f.triggered).map((f) => f.flagId);
      const { metadata } = result;

      console.log(`Session ${id}  (${conversation.messages.length} messages)`);
      console.log(`  overall: ${fmtScore(result.overallScore)}`);
      console.log(`  scores:  ${scores}`);
      console.log(`  flags:   ${triggered.length ? triggered.join(', ') : '(none)'}`);
      console.log(
        `  cost:    $${metadata.costUsd.toFixed(6)}   latency: ${metadata.latencyMs}ms   ` +
          `tokens: ${metadata.tokensIn}->${metadata.tokensOut}   ` +
          `model: ${metadata.model}   truncated: ${metadata.truncated}`,
      );
      console.log('');

      totalCost += metadata.costUsd;
      totalLatency += metadata.latencyMs;
    } catch (error) {
      // A connection failure means the server is unreachable — no point trying
      // the rest; surface the actionable hint and stop.
      if (isConnectionError(error)) {
        console.error(
          `\nCould not reach the API at ${baseUrl}.\n` +
            `Is it running? Start it with "npm run dev" (needs OPENAI_API_KEY),\n` +
            `or point the demo elsewhere with --base-url.`,
        );
        process.exit(1);
      }
      errors += 1;
      console.log(`Session ${id}  FAILED: ${(error as Error).message}\n`);
    }
  }

  const evaluated = selected.length - errors;
  console.log(
    `Done. ${evaluated}/${selected.length} evaluated · total cost $${totalCost.toFixed(6)} · ` +
      `avg latency ${evaluated ? Math.round(totalLatency / evaluated) : 0}ms · errors: ${errors}`,
  );
}

main().catch((error) => {
  console.error(`\nDemo failed: ${(error as Error).message}`);
  process.exit(1);
});
