import { isIP } from 'node:net';

interface Environment {
  fetch: typeof fetch;
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}

const environment: Environment = { fetch: (...args) => fetch(...args), now: Date.now, setTimeout, clearTimeout };
const DNS_PROVIDERS = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
const TIMEOUT = 150000;

/** Check publication without looking up the fresh hostname through the local DNS cache. */
export async function waitForTunnelReady(origin: string, log: (line: string) => void, signal: AbortSignal, env = environment): Promise<void> {
  const started = env.now(), deadline = started + TIMEOUT;
  const elapsed = () => `${Math.round((env.now() - started) / 1000)}s`;
  const hostname = new URL(origin).hostname;

  const pause = (ms: number) => new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => { env.clearTimeout(timer); reject(signal.reason); };
    const timer = env.setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, Math.min(ms, Math.max(0, deadline - env.now())));
    signal.addEventListener('abort', aborted, { once: true });
  });
  const request = async <T>(run: (requestSignal: AbortSignal) => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const controller = new AbortController();
    const aborted = () => controller.abort(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    const timer = env.setTimeout(() => controller.abort(), Math.min(5000, Math.max(0, deadline - env.now())));
    try { return await run(controller.signal); }
    finally { env.clearTimeout(timer); signal.removeEventListener('abort', aborted); }
  };
  const dns = async (provider: string): Promise<'published' | 'pending' | 'unavailable'> => {
    try {
      return await request(async requestSignal => {
        const response = await env.fetch(`${provider}?name=${encodeURIComponent(hostname)}&type=A`, {
          headers: { Accept: 'application/dns-json' }, redirect: 'error', signal: requestSignal
        });
        if (!response.ok) { await response.body?.cancel(); return 'unavailable'; }
        const answer = await response.json();
        if (answer.Status === 0 && Array.isArray(answer.Answer)
          && answer.Answer.some((item: any) => item.type === 1 && typeof item.data === 'string' && isIP(item.data) === 4)) return 'published';
        return answer.Status === 3 || answer.Status === 0 ? 'pending' : 'unavailable';
      });
    } catch { signal.throwIfAborted(); return 'unavailable'; }
  };

  log('Waiting for preview address DNS publication…');
  let nextProgress = started + 10000;
  while (env.now() < deadline) {
    const results = await Promise.all(DNS_PROVIDERS.map(dns));
    signal.throwIfAborted();
    if (results.includes('published')) {
      log(`Preview address published (${elapsed()}). Allowing DNS to settle…`);
      // A positive answer at one resolver does not mean every resolver is ready.
      // Avoid the first local lookup during the initial publication race.
      await pause(Math.max(5000, 10000 - (env.now() - started)));
      break;
    }
    const waited = env.now() - started;
    // A blocked or cached public resolver must not prevent an otherwise working
    // connection. Fall back after a warm-up, never immediately on a DoH failure.
    if ((results.every(value => value === 'unavailable') && waited >= 15000) || waited >= 30000) {
      log(`Public DNS checks are unavailable or still warming up (${elapsed()}). Checking through the computer’s DNS…`);
      break;
    }
    if (env.now() >= nextProgress) {
      log(`Waiting for preview address DNS publication… (${elapsed()})`);
      nextProgress = env.now() + 10000;
    }
    await pause(2000);
  }

  signal.throwIfAborted();
  log('Checking public preview HTTPS connection…');
  let detail = 'Public HTTPS is not responding yet', previous = '';
  nextProgress = 0;
  while (env.now() < deadline) {
    try {
      const ready = await request(async requestSignal => {
        const response = await env.fetch(`${origin}/app/`, { redirect: 'error', cache: 'no-store', signal: requestSignal });
        const ok = response.status === 200 && !!response.headers.get('content-type')?.includes('text/html');
        detail = response.status === 200 ? 'Waiting for the preview page' : `Preview gateway returned HTTP ${response.status}`;
        await response.body?.cancel();
        return ok;
      });
      signal.throwIfAborted();
      if (ready) { log(`Public preview ready: DNS and HTTPS verified (${elapsed()} after tunnel registration).`); return; }
    } catch (error: any) {
      signal.throwIfAborted();
      const code = error?.cause?.code ?? error?.code;
      detail = code === 'ENOTFOUND' || code === 'EAI_AGAIN'
        ? 'The computer’s DNS has not resolved the preview address yet'
        : 'Public HTTPS is not responding yet';
    }
    if (detail !== previous || env.now() >= nextProgress) {
      log(`${detail}. Retrying automatically… (${elapsed()})`);
      previous = detail; nextProgress = env.now() + 10000;
    }
    await pause(3000);
  }
  throw new Error(`The public preview address is still unavailable after 150 seconds. ${detail}. Check DNS/internet access and restart the session.`);
}
