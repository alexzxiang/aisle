// Day-0 probe: send one planner job to NIM exactly as the proxy does and print the RAW reply
// (before validation), so prompt/validator mismatches are visible. Usage: npx tsx scripts/probe-plan.ts
import { JOB_SPECS } from '../../src/outdoor/plannerJobs';
const spec = JOB_SPECS.answer;
const input = { question: 'how_far' as const, context: { mode: 'OUTDOOR_NAV', metersToManeuver: 120, nextManeuver: 'Turn right on Forbes Avenue', street: 'Fifth Avenue', nextStreet: 'Forbes Avenue' } };
const p: unknown = spec.prompt;
const sys = typeof p === 'function' ? (p as (i: unknown) => string)(input) : Array.isArray(p) ? p.join(' ') : String(p);
const body = { model: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-lightning-30b-a3b', messages: [{ role: 'system', content: `${sys}\nReturn exactly one JSON object and nothing else. It must match this JSON Schema: ${JSON.stringify(spec.schema)}` }, { role: 'user', content: JSON.stringify(input) }], max_tokens: 120, temperature: 0, chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_object' } };
const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
console.log('raw model reply:', j.choices?.[0]?.message?.content ?? JSON.stringify(j).slice(0, 300));
