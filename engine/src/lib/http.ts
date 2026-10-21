import { sleep } from './time';

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    url: string,
  ) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 200)}`);
  }
}

// fetch JSON dengan retry untuk error jaringan, 429 (rate limit) dan 5xx.
export async function fetchJson<T>(url: string, init: RequestInit = {}, retries = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(20_000) });
      const text = await res.text();
      if (res.ok) return JSON.parse(text) as T;
      const err = new HttpError(res.status, text, url);
      if (res.status !== 429 && res.status !== 418 && res.status < 500) throw err;
      lastErr = err;
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    } catch (e) {
      if (e instanceof HttpError && e.status !== 429 && e.status !== 418 && e.status < 500) throw e;
      lastErr = e;
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

export function postJson<T>(url: string, body: unknown, retries = 4): Promise<T> {
  return fetchJson<T>(
    url,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    retries,
  );
}
