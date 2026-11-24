// POST JSON with a timeout, mapping failures to LlmError kinds (fetch-based adapters).

import { kindForStatus, LlmError } from '../provider.ts';

export async function postJson(
  provider: string,
  url: string,
  body: unknown,
  opts: { headers: Record<string, string>; timeoutMs: number; fetch?: typeof fetch },
): Promise<unknown> {
  const f = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new LlmError('timeout', 'Request timed out', provider);
    }
    throw new LlmError('retryable', `Connection failed: ${e instanceof Error ? e.message : String(e)}`, provider);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      message = j.error?.message ?? j.message ?? message;
    } catch {
      // keep the raw text
    }
    throw new LlmError(kindForStatus(res.status), `HTTP ${res.status}: ${message}`, provider, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError('retryable', 'Response was not JSON', provider, res.status);
  }
}
