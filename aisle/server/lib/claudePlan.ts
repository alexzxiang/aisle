/**
 * Claude as the planner's understudy (round 6).
 *
 * Nemotron on the hosted NIM answers a parseIntent in 0.4–2 s on a good night
 * and misses its 4.5 s first-token deadline on a bad one, which left the app on
 * the keyword templates for the demo's most-heard sentences. So every planner
 * job also starts Haiku at t = 0 with the same prompt, schema-in-prompt and
 * input; Nemotron's answer is used when it lands in time, otherwise whatever
 * Haiku has by the deadline plus a short grace, and only then the template.
 * The unused call is aborted when a winner is selected; providers may still
 * bill tokens processed before cancellation.
 */
import Anthropic from '@anthropic-ai/sdk';
import { MODELS } from '../config';

export interface ClaudePlanParams {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface ClaudePlanHandle {
  result: Promise<{ text: string; model: string }>;
  abort(): void;
}

export type ClaudePlanStarter = (params: ClaudePlanParams) => ClaudePlanHandle;

export const CLAUDE_PLAN_TIMEOUT_MS = 8000;

/** Start a non-streaming Haiku completion that must answer with one JSON object. */
export function sdkClaudePlan(apiKey: string, timeoutMs: number = CLAUDE_PLAN_TIMEOUT_MS): ClaudePlanStarter {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: timeoutMs });
  return (params) => {
    const controller = new AbortController();
    const system = `${params.system}\nAnswer with exactly one JSON object matching this JSON Schema and nothing else:\n${JSON.stringify(params.schema)}`;
    const result = client.messages
      .create(
        {
          model: MODELS.haiku,
          max_tokens: params.maxTokens,
          temperature: 0,
          system,
          messages: [{ role: 'user', content: params.user }],
        },
        { signal: controller.signal },
      )
      .then((msg) => {
        const text = msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
        return { text, model: msg.model };
      });
    return { result, abort: () => controller.abort() };
  };
}
