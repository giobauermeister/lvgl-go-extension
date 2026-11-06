(function (root) {
  'use strict';
  function parseSession(value, currentOrigin) {
    let url = new URL(value, currentOrigin);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error('Use an LVGL Go pairing link from the extension.');
    if (url.pathname === '/app/' || url.pathname === '/app/index.html') {
      const params = new URLSearchParams(url.hash.slice(1));
      if (params.getAll('session').length !== 1) throw new Error('Scan a fresh LVGL Go QR code.');
      const session = params.get('session');
      if (!session || (!session.startsWith('/s/') && !/^https?:\/\//.test(session))) throw new Error('Invalid preview session.');
      url = new URL(session, url.origin);
    }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid preview session URL.');
    const pathname = url.pathname;
    if (!/^\/s\/[a-f0-9]{48}\/$/.test(pathname)) throw new Error('This is not an LVGL Go pairing link. Scan a fresh QR code from the extension.');
    if (new URL(currentOrigin).protocol === 'https:' && url.protocol !== 'https:') throw new Error('This HTTPS app cannot connect to a local HTTP preview. Open the local pairing link directly in your browser, or scan its QR code with your phone’s camera.');
    return { base: new URL(pathname, url.origin).href, origin: url.origin, path: pathname, sameOrigin: url.origin === currentOrigin,
      appUrl: url.origin + '/app/#session=' + encodeURIComponent(pathname) };
  }
  const api = { parseSession };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LVGLGoSession = api;
})(typeof globalThis === 'object' ? globalThis : this);
