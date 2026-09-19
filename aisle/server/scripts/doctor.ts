import 'dotenv/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HealthReport } from '../lib/health';

export const DOCTOR_TIMEOUT_MS = 4500;
/** Per-upstream probe budget on a cold check: bounds the request so a dead network still
 * diagnoses within the five-second window instead of just reporting PROXY TIMEOUT. */
export const DOCTOR_BUDGET_MS = 1500;

export function failureKind(message: string): string {
  if (/not set|missing.*key/i.test(message)) return 'MISSING KEY';
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid.*key/i.test(message)) return 'AUTH / PERMISSION'; // lint-phrases: allow
  if (/\b429\b|quota|credits/i.test(message)) return 'QUOTA';
  if (/timeout|timed out|fetch failed|ENOTFOUND|EAI_AGAIN|ECONN|network|socket/i.test(message)) return 'NETWORK';
  return 'UPSTREAM';
}

export function formatHealth(report: HealthReport, colour = true): string {
  const paint = (code: number, text: string) => colour ? `\u001b[${code}m${text}\u001b[0m` : text;
  const lines = Object.entries({ ...report.upstreams, overpass: report.overpass }).map(([name, s]) => {
    const optional = 'required' in s && s.required === false;
    const label = s.ok ? 'OK' : `${optional ? 'OPTIONAL ' : ''}${failureKind(s.err ?? '')}`;
    return `${paint(s.ok ? 32 : optional ? 33 : 31, label)} ${name} (${s.ms ?? '?'} ms)`;
  });
  if (report.missingKeys.length) lines.push(paint(31, `Missing: ${report.missingKeys.join(', ')}`));
  return lines.join('\n');
}

export async function doctor(baseUrl: string, opts: { fetchFn?: typeof fetch; write?: (s: string) => void; colour?: boolean; timeoutMs?: number; budgetMs?: number } = {}): Promise<number> {
  const write = opts.write ?? ((s) => process.stdout.write(`${s}\n`));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DOCTOR_TIMEOUT_MS);
  try {
    const res = await (opts.fetchFn ?? fetch)(`${baseUrl.replace(/\/$/, '')}/api/health?budgetMs=${opts.budgetMs ?? DOCTOR_BUDGET_MS}`, { signal: controller.signal });
    if (!res.ok) {
      write(`PROXY ${failureKind(String(res.status))}: HTTP ${res.status}`);
      return 1;
    }
    const report = await res.json() as HealthReport;
    if (!report.upstreams || !report.overpass || !Array.isArray(report.missingKeys)) throw new Error('invalid health response');
    write(formatHealth(report, opts.colour ?? !('NO_COLOR' in process.env)));
    return report.ok && report.overpass.ok && report.missingKeys.length === 0 ? 0 : 1;
  } catch (e) {
    // Do not print response bodies/URLs/errors: they can contain credentials.
    write(controller.signal.aborted
      ? 'PROXY TIMEOUT: health report exceeded the budget; upstream probes may still be running.'
      : `PROXY ${failureKind(e instanceof Error ? e.message : '')}: check the proxy address and connection.`);
    return 1;
  } finally { clearTimeout(timer); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void doctor(process.argv[2] ?? process.env.EXPO_PUBLIC_PROXY_URL ?? `http://127.0.0.1:${process.env.PORT ?? 8787}`)
    .then((code) => { process.exitCode = code; });
}
