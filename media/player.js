/* Shared by the PWA and the standalone WASM shell. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LVGLGoPlayer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const keys = { ArrowUp: 17, ArrowDown: 18, ArrowRight: 19, ArrowLeft: 20,
    Enter: 10, Escape: 27, Backspace: 8, Delete: 127, Tab: 9,
    PageDown: 9, PageUp: 11, Home: 2, End: 3 };
  function keyCode(event) {
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return 0;
    if (event.key === 'Tab' && event.shiftKey) return 11;
    if (Object.hasOwn(keys, event.key)) return keys[event.key];
    return typeof event.key === 'string' && event.key.length === 1 && event.key.charCodeAt(0) >= 32 && event.key.charCodeAt(0) <= 126 ? event.key.charCodeAt(0) : 0;
  }
  function scale(width, height, availableWidth, availableHeight, mode = 'auto') {
    if (![width, height, availableWidth, availableHeight].every(n => Number.isFinite(n) && n > 0)) return 1;
    return Math.min(mode === 'fit' ? Infinity : 1, availableWidth / width, availableHeight / height);
  }
  function isControl(target) {
    return !!target?.closest?.('input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"])');
  }
  function trackDownloads(env, report) {
    if (!env.fetch || !env.ReadableStream || !env.Response || env.parent === env) return () => {};
    const original = env.fetch;
    const bundle = new URL('.', env.location.href);
    const tracked = url => url.startsWith(bundle.href) && (/\.(wasm|data)$/i.test(new URL(url).pathname) || /\/lvgl-go-overlay\/frame-\d+\.(png|jpe?g|webp|gif|svg)$/i.test(new URL(url).pathname));
    // Observe the existing loader's stream; preserve streaming compilation and
    // count decoded bytes so gzip/proxy compression cannot distort percentages.
    async function fetchWithProgress(...args) {
      const requested = new URL(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0].url, env.location.href).href;
      if (tracked(requested)) report({ type: 'lvgl-go-progress', url: requested, loaded: 0, done: false });
      const response = await original.apply(env, args);
      if (!response.ok || !response.body || !tracked(response.url)) return response;
      const reader = response.body.getReader();
      let loaded = 0, lastReport = 0, lastLoaded = 0;
      const notify = done => {
        const now = Date.now();
        if (done || loaded === 0 || lastLoaded === 0 || now - lastReport >= 50) {
          lastReport = now; lastLoaded = loaded;
          report({ type: 'lvgl-go-progress', url: response.url, loaded, done });
        }
      };
      notify(false);
      const body = new env.ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { controller.close(); notify(true); }
            else { loaded += value.byteLength; controller.enqueue(value); notify(false); }
          } catch (error) { controller.error(error); }
        },
        cancel: reason => reader.cancel(reason)
      });
      return new env.Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    env.fetch = fetchWithProgress;
    return () => { if (env.fetch === fetchWithProgress) env.fetch = original; };
  }
  function install(module, canvas, env = window, options = {}) {
    let ready = false, failed = false, mode = 'auto';
    let screens = [];
    // The launcher pins its origin in the iframe fragment (not sent to the
    // server). The preview server separately restricts allowed frame ancestors.
    let parentOrigin = env.location.origin;
    const requestedParent = new URLSearchParams((env.location.hash || '').replace(/^#/, '')).get('lvgl-go-parent');
    if (requestedParent) {
      try {
        const url = new URL(requestedParent);
        if (url.origin === requestedParent && url.protocol === 'https:') parentOrigin = url.origin;
      } catch { /* Standalone/legacy preview keeps the same-origin bridge. */ }
    }
    const report = message => { if (options.report) options.report(message); else if (env.parent !== env) env.parent.postMessage(message, parentOrigin); };
    let memoryTimer = null, memoryUnavailable = false;
    function memorySample() {
      if (failed || memoryUnavailable || !module._lvgl_go_memory_snapshot || !module.UTF8ToString) return;
      try {
        const sample = JSON.parse(module.UTF8ToString(module._lvgl_go_memory_snapshot()));
        report({ type: 'lvgl-go-memory', ...sample, time: Date.now(),
          screen: module._lvgl_go_screen_current?.() ?? -1 });
      } catch (error) {
        memoryUnavailable = true; stopMemory(); log('error', ['Memory monitor stopped:', error]);
        report({ type: 'lvgl-go-memory-stopped' });
      }
    }
    function stopMemory() { if (memoryTimer !== null) env.clearInterval(memoryTimer); memoryTimer = null; }
    env.addEventListener('pagehide', stopMemory);
    env.addEventListener('pageshow', () => {
      if (ready && !failed && !memoryUnavailable && memoryTimer === null && module._lvgl_go_memory_snapshot) memoryTimer = env.setInterval(memorySample, 250);
    });
    function log(level, args) {
      const text = args.map(value => {
        if (value?.stack) return String(value.stack);
        if (typeof value === 'string') return value;
        try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
      }).join(' ').slice(0, 8192);
      const tag = text.match(/^\s*\[(trace|info|warn|error|user)\]/i)?.[1]?.toLowerCase();
      report({ type: 'lvgl-go-log', level: tag || level, text, time: Date.now() });
    }
    // Install before the Emscripten loader snapshots these hooks. Keep browser
    // developer tools useful too, without patching the global console object.
    for (const [name, level] of [['print', 'info'], ['printErr', 'error']]) {
      const original = module[name];
      module[name] = (...args) => { log(level, args); original?.(...args); };
    }
    env.addEventListener('error', event => {
      log('error', [event.error || event.message || ('Could not load ' + (event.target?.src || event.target?.href || 'runtime resource'))]);
    }, true);
    env.addEventListener('unhandledrejection', event => log('error', [event.reason || 'Unhandled runtime promise rejection']));
    const stopTracking = trackDownloads(env, report);
    const hardware = env.LVGLGoHardware?.install(module, canvas, env, { key: send, baseUrl: options.baseUrl, changed: state => {
      fit();
      if (ready) report({ type: 'lvgl-go-display', ...state });
    } });
    module.lvglGoDisplayChanged = () => hardware?.sync();
    module.lvglGoScreenChanged = current => {
      if (ready) report({ type: 'lvgl-go-screen', current });
    };
    function fit() {
      if (hardware) { hardware.fit(mode); return; }
      const container = canvas.parentElement;
      const width = container?.clientWidth || env.innerWidth;
      const height = container?.clientHeight || env.innerHeight;
      const ratio = scale(canvas.width, canvas.height, width, height, mode);
      canvas.style.width = canvas.width * ratio + 'px';
      canvas.style.height = canvas.height * ratio + 'px';
    }
    function focus() { canvas.focus({ preventScroll: true }); }
    function send(event) {
      const key = keyCode(event);
      if (!ready || !key) return false;
      return module._lvgl_go_send_key(key) === 1;
    }
    for (const type of ['keydown', 'keypress', 'keyup']) env.addEventListener(type, event => {
      if (!ready || isControl(event.target) || !keyCode(event)) return;
      // SDL2's browser backend uses legacy keyCode. Consume the matching native
      // events so our event.key translation reaches the SDL keypad exactly once.
      if (type === 'keydown' && !send(event)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    function handle(data) {
      hardware?.handle(data);
      if (data.type === 'lvgl-go-key') return send(data);
      if (data.type === 'lvgl-go-focus') focus();
      if (data.type === 'lvgl-go-scale' && ['auto', 'fit'].includes(data.mode)) { mode = data.mode; fit(); }
      if (data.type === 'lvgl-go-select-screen' && ready && Number.isInteger(data.index) && data.index >= 0 && data.index < screens.length) {
        module._lvgl_go_select_screen(data.index);
        report({ type: 'lvgl-go-screen', current: module._lvgl_go_screen_current() });
        focus();
      }
    }
    env.addEventListener('message', event => {
      if (options.report || event.origin !== parentOrigin || event.source !== env.parent || !event.data) return;
      handle(event.data);
    });
    new env.MutationObserver(() => { if (hardware) hardware.sync(); else fit(); }).observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
    // The rendered surface can resize separately from the window during rotation.
    const container = hardware?.viewport || canvas.parentElement;
    if (env.ResizeObserver && container) new env.ResizeObserver(fit).observe(container);
    env.addEventListener('resize', fit);
    canvas.addEventListener('pointerdown', focus);
    return {
      handle,
      ready() {
        ready = true;
        const finish = () => {
          stopTracking();
          if (failed) return;
          fit(); focus();
          if (module._lvgl_go_screen_list && module._lvgl_go_select_screen && module._lvgl_go_screen_current && module.UTF8ToString) {
            screens = JSON.parse(module.UTF8ToString(module._lvgl_go_screen_list()));
          }
          report({ type: 'lvgl-go-ready', screens, current: screens.length ? module._lvgl_go_screen_current() : -1 });
          memorySample();
          if (!memoryUnavailable && module._lvgl_go_memory_snapshot && memoryTimer === null) memoryTimer = env.setInterval(memorySample, 250);
        };
        const hardwareReady = hardware?.ready();
        if (hardwareReady?.then) return hardwareReady.then(finish);
        finish();
      },
      failed(reason) {
        // Emscripten invokes onAbort before shutting down. Preserve the final
        // allocation failure/peak when no interval could run before the abort.
        memorySample();
        if (reason !== undefined) log('error', ['WASM runtime stopped:', reason]);
        failed = true; ready = false; stopTracking(); report({ type: 'lvgl-go-error' });
        stopMemory();
      }
    };
  }
  return { keyCode, scale, isControl, install };
});
