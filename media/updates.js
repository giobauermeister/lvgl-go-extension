(function (root) {
  'use strict';
  // Registering a tunnel does not guarantee the new hostname resolves on the
  // device yet. Keep initial pairing recoverable across that DNS/edge delay.
  async function connectSession(base, { signal, onRetry = () => {}, timeout = 150000 } = {}, environment) {
    const env = environment || root, deadline = env.Date.now() + timeout;
    const canceled = () => new Error('Connection canceled.');
    const terminal = message => Object.assign(new Error(message), { terminal: true });
    let attempts = 0;
    while (!signal?.aborted) {
      const remaining = deadline - env.Date.now();
      if (remaining <= 0) break;
      const request = new env.AbortController();
      const abort = () => request.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = env.setTimeout(abort, Math.min(10000, remaining));
      try {
        const response = await env.fetch(base + 'manifest.json', { cache: 'no-store', credentials: 'omit', signal: request.signal });
        if (!response.ok) {
          if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) throw terminal('Session unavailable. Start LVGL Go on your computer and scan its new QR code.');
          throw new Error('Preview address not ready.');
        }
        const state = await response.json();
        if (state.protocol !== 1) throw terminal('Unsupported preview protocol.');
        if (signal?.aborted) throw canceled();
        return state;
      } catch (error) {
        if (signal?.aborted) throw canceled();
        if (error?.terminal) throw error;
      } finally {
        env.clearTimeout(timer); signal?.removeEventListener('abort', abort);
      }
      const remainingAfterRequest = deadline - env.Date.now();
      if (remainingAfterRequest <= 0) break;
      onRetry();
      const delay = Math.min(1000 * 2 ** Math.min(attempts++, 3), 5000, remainingAfterRequest);
      await new Promise((resolve, reject) => {
        let timer;
        const abort = () => { env.clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(canceled()); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        timer = env.setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
      });
    }
    if (signal?.aborted) throw canceled();
    throw new Error('The preview address is still unavailable. Check that LVGL Go is running on your computer, then try Reconnect.');
  }
  // Quick Tunnels do not carry SSE. Use one bounded request at a time there,
  // and fall back to polling when an SSE connection fails on another proxy.
  function watchSession(base, transport, onUpdate, onDisconnect, environment) {
    const env = environment || root;
    let stopped = false, timer = null, source = null, request = null;
    async function poll() {
      if (stopped) return;
      request = new AbortController();
      const timeout = env.setTimeout(() => request?.abort(), 10000);
      try {
        const response = await env.fetch(base + 'manifest.json', { cache: 'no-store', credentials: 'omit', signal: request.signal });
        if (!response.ok) throw new Error('Session unavailable');
        const state = await response.json();
        if (state.protocol !== 1) throw new Error('Unsupported protocol');
        if (!stopped) onUpdate(state);
      } catch { if (!stopped) onDisconnect(); }
      finally { env.clearTimeout(timeout); request = null; if (!stopped) timer = env.setTimeout(poll, 2000); }
    }
    function startPolling() {
      source?.close(); source = null;
      if (!stopped && timer === null && request === null) timer = env.setTimeout(() => { timer = null; void poll(); }, 1000);
    }
    if (transport !== 'poll' && env.EventSource) {
      source = new env.EventSource(base + 'events');
      source.onmessage = event => { try { if (!stopped) onUpdate(JSON.parse(event.data)); } catch { onDisconnect(); startPolling(); } };
      source.onerror = () => { if (!stopped) { onDisconnect(); startPolling(); } };
    } else startPolling();
    return () => { stopped = true; source?.close(); env.clearTimeout(timer); request?.abort(); };
  }
  if (typeof module === 'object' && module.exports) module.exports = { watchSession, connectSession };
  else root.LVGLGoUpdates = { watchSession, connectSession };
})(typeof globalThis === 'object' ? globalThis : this);
