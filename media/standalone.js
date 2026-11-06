/* Standalone exports use the same player and hardware renderer as live previews. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id), canvas = $('canvas');
  let player, viewControls = null, ready = false, screenNames = [], displayNames = [], screenButtons = [], displayButtons = [];
  const send = data => player?.handle(data);
  const focus = () => { if (ready && docBudgetActive() === false && $('screen-menu').hidden && $('display-menu').hidden && !viewControls.isOpen()) canvas.focus({ preventScroll: true }); };
  const docBudgetActive = () => document.activeElement === $('memory-budget');
  const runtimeConsole = LVGLGoConsole.install(document, window, focus);
  const memoryMonitor = LVGLGoMemory.install(document, focus);
  viewControls = LVGLGoView.install(document, focus, closeMenus);
  function height() { document.documentElement.style.setProperty('--preview-height', (visualViewport?.height || innerHeight) + 'px'); }
  height(); addEventListener('resize', height); globalThis.visualViewport?.addEventListener('resize', height);
  function closeMenus(restore = false) {
    for (const name of ['screen', 'display']) { $(name + '-menu').hidden = true; $(name + '-select').setAttribute('aria-expanded', 'false'); }
    $('screen-dismiss').hidden = true;
    document.documentElement.style.setProperty('--player-touch-action', viewControls?.isOpen() ? 'pan-y' : 'none');
    if (restore) focus();
  }
  function menu(name) {
    const open = $(name + '-menu').hidden;
    closeMenus();
    if (open) {
      $(name + '-menu').hidden = false; $(name + '-select').setAttribute('aria-expanded', 'true');
      $('screen-dismiss').hidden = false; document.documentElement.style.setProperty('--player-touch-action', 'pan-y');
    } else focus();
  }
  function choices(name, labels, select) {
    const buttons = labels.map((label, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.tabIndex = -1; button.textContent = label;
      button.onclick = () => { closeMenus(); select(index); focus(); };
      return button;
    });
    $(name + '-menu').replaceChildren(...buttons); $(name + '-control').hidden = labels.length <= 1;
    return buttons;
  }
  function selected(name, labels, buttons, index, fallback) {
    $(name + '-value').textContent = labels[index] || fallback;
    $(name + '-select').setAttribute('aria-label', name + ': ' + (labels[index] || fallback));
    buttons.forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  }
  function report(data) {
    if (data.type === 'lvgl-go-log') { runtimeConsole.append(data); return; }
    if (data.type === 'lvgl-go-memory') { memoryMonitor.append(data); return; }
    if (data.type === 'lvgl-go-memory-stopped') { memoryMonitor.stop(); return; }
    if (data.type === 'lvgl-go-display') {
      const names = data.targets.map(target => target.name);
      if (JSON.stringify(displayNames) !== JSON.stringify(names)) {
        displayNames = names;
        displayButtons = choices('display', names, index => send({ type: 'lvgl-go-select-display', index }));
      }
      selected('display', displayNames, displayButtons, data.current, 'Custom display');
      $('frame-control').hidden = !data.frameAvailable; $('frame-toggle').checked = data.frameVisible;
    }
    if (data.type === 'lvgl-go-ready') {
      ready = true; $('loading').hidden = true;
      screenNames = data.screens;
      memoryMonitor.screens(screenNames);
      screenButtons = choices('screen', screenNames, index => send({ type: 'lvgl-go-select-screen', index }));
      selected('screen', screenNames, screenButtons, data.current, 'Current screen'); focus();
    }
    if (data.type === 'lvgl-go-screen') selected('screen', screenNames, screenButtons, data.current, 'Current screen');
    if (data.type === 'lvgl-go-error') fail('The UI could not start. Try opening this HTML file in a current browser.');
  }
  function fail(message) {
    memoryMonitor.stop();
    runtimeConsole.append({ level: 'error', text: message });
    ready = false; $('loading').hidden = true; $('shared-error').hidden = false;
    $('shared-error').textContent = message; closeMenus();
  }
  for (const name of ['screen', 'display']) $(name + '-select').onclick = () => menu(name);
  $('screen-dismiss').onclick = () => closeMenus(true);
  $('frame-toggle').onchange = () => { send({ type: 'lvgl-go-frame', visible: $('frame-toggle').checked }); focus(); };
  for (const mode of ['auto', 'fit']) $('scale-' + mode).onclick = () => {
    for (const option of ['auto', 'fit']) $('scale-' + option).setAttribute('aria-pressed', String(mode === option));
    send({ type: 'lvgl-go-scale', mode }); focus();
  };
  document.addEventListener('pointerdown', event => {
    if (!$('preview-controls').contains(event.target) && event.target !== $('screen-dismiss')) closeMenus();
  });
  // Preview controls stay touch-only; physical keys always navigate the UI.
  for (const type of ['keydown', 'keypress', 'keyup']) addEventListener(type, event => {
    if (event.target === $('memory-budget')) {
      // SDL also listens on this page. Keep native text editing out of its handlers.
      event.stopImmediatePropagation(); return;
    }
    if (!ready || !LVGLGoPlayer.isControl(event.target)) return;
    if (type === 'keydown') canvas.focus({ preventScroll: true });
    if (!LVGLGoPlayer.keyCode(event)) return;
    if (type === 'keydown') send({ type: 'lvgl-go-key', key: event.key, shiftKey: event.shiftKey });
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  addEventListener('pageshow', focus); document.addEventListener('visibilitychange', () => { if (!document.hidden) focus(); });
  document.addEventListener('gesturestart', event => event.preventDefault(), { passive: false });
  document.addEventListener('gesturechange', event => event.preventDefault(), { passive: false });
  document.addEventListener('dblclick', event => event.preventDefault());

  async function boot() {
    if (!globalThis.DecompressionStream) throw new Error('Open this preview in a current Chrome, Edge, Firefox or Safari browser.');
    const bytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0));
    const packed = $('lvgl-go-bundle').textContent.trim(); $('lvgl-go-bundle').remove();
    const bundle = await new Response(new Blob([bytes(packed)]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
    const base = new URL('https://lvgl-go.invalid/bundle/'), runtimeBase = new URL(bundle.folder === '.' ? './' : bundle.folder + '/', base);
    const decoded = new Map();
    function file(value) {
      const url = new URL(value, runtimeBase);
      if (!url.href.startsWith(base.href)) throw new Error('This standalone preview cannot load external assets.');
      const name = decodeURIComponent(url.pathname.slice(base.pathname.length));
      if (!Object.hasOwn(bundle.files, name)) throw new Error('A required preview asset is missing: ' + name);
      if (!decoded.has(name)) decoded.set(name, bytes(bundle.files[name].data));
      return { url, bytes: decoded.get(name), type: bundle.files[name].type };
    }
    // Resolve packaged assets in memory, including when this page is opened via file://.
    // There is no network fallback, session token, service worker or live connection.
    globalThis.fetch = async input => {
      const asset = file(typeof input === 'string' || input instanceof URL ? input : input.url);
      const response = new Response(asset.bytes, { headers: { 'Content-Type': asset.type } });
      Object.defineProperty(response, 'url', { value: asset.url.href });
      return response;
    };
    globalThis.Module = {
      canvas, wasmBinary: file(new URL(bundle.wasm, base)).bytes,
      locateFile: name => file(name).url.href,
      getPreloadedPackage: name => file(name).bytes.buffer,
      print: (...args) => console.log(...args), printErr: (...args) => console.error(...args),
      postRun: () => player.ready(), onAbort: reason => player.failed(reason)
    };
    player = LVGLGoPlayer.install(Module, canvas, window, { baseUrl: runtimeBase.href, report });
    const asset = file(new URL(bundle.script, base));
    const source = URL.createObjectURL(new Blob([asset.bytes], { type: 'text/javascript' }));
    const script = document.createElement('script'); script.src = source;
    script.onload = () => URL.revokeObjectURL(source);
    script.onerror = () => { URL.revokeObjectURL(source); fail('The UI could not start in this browser.'); };
    document.body.append(script);
  }
  requestAnimationFrame(() => setTimeout(() => { boot().catch(error => fail(error.message)); }, 0));
})();
