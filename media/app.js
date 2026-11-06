/* global jsQR, LVGLGoSession, LVGLGoUpdates, LVGLGoPlayer, LVGLGoConsole, LVGLGoMemory, LVGLGoView */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  function syncPreviewHeight() {
    const height = globalThis.visualViewport?.height || innerHeight;
    if (height > 0) document.documentElement.style.setProperty('--preview-height', height + 'px');
  }
  syncPreviewHeight();
  addEventListener('resize', syncPreviewHeight);
  globalThis.visualViewport?.addEventListener('resize', syncPreviewHeight);
  let stopUpdates = null, current = null, base = null;
  let connecting = null;
  let stream = null, scanFrame = 0, scanGeneration = 0, connectionGeneration = 0;
  let installPrompt = null;
  let scaleMode = 'auto', frameMode = null;
  let startupTimer = null;
  let viewControls = null;
  const downloads = new Map();
  let fixedDownloadPlan = false;
  let screens = [], screenButtons = [], selectedScreen = -1, screenGesture = false;
  let targets = [], targetButtons = [], displayGesture = false, selectedDisplay = null, restoreDisplay = true;
  $('display-menu').hidden = true;
  function syncMenus() {
    const open = !$('screen-menu').hidden || !$('display-menu').hidden;
    $('screen-dismiss').hidden = !open;
    document.documentElement.style.setProperty('--player-touch-action', open || viewControls?.isOpen() ? 'pan-y' : 'none');
  }
  function closeDisplayMenu(restoreFocus = false) {
    displayGesture = false;
    $('display-menu').hidden = true;
    $('display-select').setAttribute('aria-expanded', 'false');
    syncMenus();
    if (restoreFocus) focusUI(true);
  }
  function displayOptions(state) {
    if (!Array.isArray(state.targets) || !state.targets.every(t => typeof t.name === 'string' && t.name.length > 0 && t.name.length <= 200 && Number.isInteger(t.width) && t.width > 0 && Number.isInteger(t.height) && t.height > 0)) return;
    if (JSON.stringify(targets) !== JSON.stringify(state.targets)) {
      closeDisplayMenu(); targets = state.targets;
      targetButtons = targets.map((target, index) => {
        const button = document.createElement('button');
        button.type = 'button'; button.tabIndex = -1; button.textContent = target.name;
        button.title = target.width + ' × ' + target.height;
        button.onclick = () => {
          closeDisplayMenu(); selectedDisplay = target.name; postToUI({ type: 'lvgl-go-select-display', index }); focusUI(true);
        };
        return button;
      });
      $('display-menu').replaceChildren(...targetButtons);
    }
    if (restoreDisplay && targets.length) {
      restoreDisplay = false;
      const index = targets.findIndex(target => target.name === selectedDisplay);
      if (index >= 0 && index !== state.current) postToUI({ type: 'lvgl-go-select-display', index });
      else selectedDisplay = targets[state.current]?.name || selectedDisplay;
    } else selectedDisplay = targets[state.current]?.name || selectedDisplay;
    $('display-control').hidden = targets.length <= 1;
    $('display-select').textContent = targets[state.current]?.name || 'Custom display';
    targetButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === state.current)));
    $('frame-control').hidden = state.frameAvailable !== true;
    $('frame-toggle').checked = state.frameVisible === true;
  }
  function closeScreenMenu(restoreFocus = false) {
    screenGesture = false;
    $('screen-menu').hidden = true;
    $('screen-select').setAttribute('aria-expanded', 'false');
    syncMenus();
    if (restoreFocus) focusUI(true);
  }
  function selectScreen(current) {
    selectedScreen = Number.isInteger(current) && current >= 0 && current < screens.length ? current : -1;
    $('screen-select').textContent = screens[selectedScreen] || 'Current screen';
    $('screen-select').setAttribute('aria-label', 'Screen: ' + $('screen-select').textContent);
    screenButtons.forEach((button, index) => button.setAttribute('aria-pressed', String(index === selectedScreen)));
  }
  function openScreenMenu() {
    if (screens.length <= 1 || $('screen-control').hidden) return;
    closeDisplayMenu();
    $('screen-menu').hidden = false;
    $('screen-dismiss').hidden = false;
    $('screen-select').setAttribute('aria-expanded', 'true');
    document.documentElement.style.setProperty('--player-touch-action', 'pan-y');
  }
  function screenOptions(names, current) {
    closeScreenMenu();
    screens = Array.isArray(names) && names.every(name => typeof name === 'string' && name.length > 0 && name.length <= 200) ? names : [];
    memoryMonitor.screens(screens);
    screenButtons = screens.map((name, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.textContent = name; button.tabIndex = -1;
      button.onclick = () => {
        closeScreenMenu();
        postToUI({ type: 'lvgl-go-select-screen', index });
        focusUI(true);
      };
      return button;
    });
    $('screen-menu').replaceChildren(...screenButtons);
    selectScreen(current);
    $('screen-control').hidden = screens.length <= 1;
  }
  closeScreenMenu();
  function resetLoading() {
    clearTimeout(startupTimer); startupTimer = null;
    downloads.clear();
    fixedDownloadPlan = false;
    closeScreenMenu(); closeDisplayMenu();
    targets = []; targetButtons = []; restoreDisplay = true; $('display-control').hidden = true; $('frame-control').hidden = true;
    screens = []; screenButtons = []; selectedScreen = -1; $('screen-control').hidden = true;
    $('loading-label').textContent = 'Loading UI…';
    $('loading-progress').hidden = true;
    $('loading-progress').value = 0;
    $('loading-details').hidden = true;
  }
  function downloadProgress() {
    const files = [...downloads.values()].filter(file => file.active);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (!total) return;
    const loaded = files.reduce((sum, file) => sum + file.loaded, 0);
    const percent = Math.floor(loaded / total * 100);
    const unit = total >= 1e6 ? 'MB' : 'KB', divisor = total >= 1e6 ? 1e6 : 1e3;
    if ($('loading-label').textContent !== 'Downloading UI…') $('loading-label').textContent = 'Downloading UI…';
    $('loading-progress').hidden = false;
    $('loading-progress').value = percent;
    $('loading-details').hidden = false;
    $('loading-details').textContent = `${percent}% · ${(loaded / divisor).toFixed(1)} / ${(total / divisor).toFixed(1)} ${unit}`;
    if (!files.every(file => file.done)) {
      clearTimeout(startupTimer); startupTimer = null;
    } else if (startupTimer === null) {
      // Fast startup goes straight to the UI, with no extra label flashing past.
      startupTimer = setTimeout(() => {
        $('loading-label').textContent = 'Starting UI…';
        $('loading-progress').hidden = true;
        $('loading-details').hidden = true;
      }, 500);
    }
  }
  const storageKey = 'lvgl-go:last-session';
  function previewOrigin() { return base ? new URL(base).origin : null; }
  const postToUI = message => { if (current && base) $('ui').contentWindow?.postMessage(message, previewOrigin()); };
  const runtimeConsole = LVGLGoConsole.install(document, globalThis, () => focusUI(true));
  const memoryMonitor = LVGLGoMemory.install(document, () => focusUI(true));
  viewControls = LVGLGoView.install(document, () => focusUI(true), () => { closeScreenMenu(); closeDisplayMenu(); });
  function connection(connected, label = connected ? 'Connected' : 'Disconnected') {
    $('connection-led').classList.toggle('on', connected);
    $('connection-label').textContent = label;
  }
  function focusRuntime() {
    if (document.activeElement !== $('ui')) $('ui').focus({ preventScroll: true });
    postToUI({ type: 'lvgl-go-focus' });
  }
  function focusUI(force = false) {
    if (!current || $('player').hidden || document.hidden || $('scanner').open || $('install-dialog').open) return;
    if (viewControls.isOpen()) return;
    if (screenGesture || displayGesture || !$('screen-menu').hidden || !$('display-menu').hidden) return;
    // Leave controls focused during interaction; restore the UI after use.
    if (force !== true && document.activeElement === $('memory-budget')) return;
    if (force !== true && [ $('scale-auto'), $('scale-fit'), $('screen-select'), $('display-select'), $('frame-toggle') ].includes(document.activeElement)) return;
    focusRuntime();
  }
  $('ui').addEventListener('load', focusUI);
  // Let the browser finish focusing a toolbar/dropdown control before deciding
  // whether to return keyboard input to the frame.
  addEventListener('focus', () => requestAnimationFrame(focusUI));
  addEventListener('pageshow', () => { syncPreviewHeight(); focusUI(); });
  for (const mode of ['auto', 'fit']) $('scale-' + mode).onclick = () => {
    scaleMode = mode;
    for (const value of ['auto', 'fit']) $('scale-' + value).setAttribute('aria-pressed', String(value === mode));
    postToUI({ type: 'lvgl-go-scale', mode });
    focusUI(true);
  };
  $('screen-select').addEventListener('pointerdown', () => { screenGesture = true; });
  document.addEventListener('pointerup', () => { screenGesture = false; displayGesture = false; });
  document.addEventListener('pointercancel', () => { screenGesture = false; displayGesture = false; });
  $('screen-select').onclick = () => {
    if ($('screen-menu').hidden) openScreenMenu();
    else closeScreenMenu(true);
  };
  $('display-select').addEventListener('pointerdown', () => { displayGesture = true; });
  $('display-select').onclick = () => {
    if (!$('display-menu').hidden) { closeDisplayMenu(true); return; }
    closeScreenMenu();
    $('display-menu').hidden = false;
    $('display-select').setAttribute('aria-expanded', 'true');
    syncMenus();
  };
  $('frame-toggle').onchange = () => { frameMode = $('frame-toggle').checked; postToUI({ type: 'lvgl-go-frame', visible: frameMode }); focusUI(true); };
  $('screen-dismiss').onclick = () => { closeScreenMenu(); closeDisplayMenu(true); };
  document.addEventListener('pointerdown', event => {
    if ((!$('screen-menu').hidden || !$('display-menu').hidden) && !$('preview-controls').contains(event.target) && event.target !== $('screen-dismiss')) { closeScreenMenu(); closeDisplayMenu(); }
  });
  addEventListener('message', event => {
    if (!current || event.origin !== previewOrigin() || event.source !== $('ui').contentWindow) return;
    if (event.data?.type === 'lvgl-go-log') { runtimeConsole.append(event.data); return; }
    if (event.data?.type === 'lvgl-go-memory') { memoryMonitor.append(event.data); return; }
    if (event.data?.type === 'lvgl-go-memory-stopped') { memoryMonitor.stop(); return; }
    if (event.data?.type === 'lvgl-go-display') { displayOptions(event.data); return; }
    if (event.data?.type === 'lvgl-go-screen') {
      if (!$('screen-control').hidden) selectScreen(event.data.current);
      return;
    }
    if (event.data?.type === 'lvgl-go-progress') {
      const file = downloads.get(event.data.url);
      if (!file || $('loading').hidden || !Number.isSafeInteger(event.data.loaded) || event.data.loaded < 0 || event.data.loaded > file.size) return;
      if (fixedDownloadPlan && !file.active) return;
      file.active = true;
      file.loaded = event.data.loaded; file.done = event.data.done === true && file.loaded === file.size;
      downloadProgress();
      return;
    }
    if (!['lvgl-go-ready', 'lvgl-go-error'].includes(event.data?.type)) return;
    clearTimeout(startupTimer); startupTimer = null;
    $('loading').hidden = true;
    $('ui').setAttribute('aria-busy', 'false');
    if (event.data.type === 'lvgl-go-error') memoryMonitor.stop();
    if (event.data.type === 'lvgl-go-error') { closeScreenMenu(); closeDisplayMenu(); $('display-control').hidden = true; $('frame-control').hidden = true; $('screen-control').hidden = true; $('status').textContent = 'UI failed to load'; return; }
    screenOptions(event.data.screens, event.data.current);
    if (frameMode !== null) postToUI({ type: 'lvgl-go-frame', visible: frameMode });
    postToUI({ type: 'lvgl-go-scale', mode: scaleMode }); focusUI();
  });
  addEventListener('keydown', event => {
    if (event.target === $('memory-budget')) return;
    if ($('player').hidden || !current) return;
    const screenControl = $('preview-controls').contains(event.target) || $('screen-control').contains(event.target) || $('runtime-console').contains(event.target) || $('memory-popup').contains(event.target) || $('view-controls').contains(event.target) || event.target === $('screen-dismiss');
    if (!screenControl && LVGLGoPlayer.isControl(event.target)) return;
    // Any key leaves a touch control, including modifiers and unsupported keys.
    // Keep pointer focus rules separate so tapping a dropdown still opens it.
    if (screenControl) focusRuntime();
    if (!LVGLGoPlayer.keyCode(event)) return;
    // Preview controls are touch-only. Physical buttons always control the UI.
    event.preventDefault();
    event.stopImmediatePropagation?.();
    postToUI({ type: 'lvgl-go-key', key: event.key, shiftKey: event.shiftKey, repeat: event.repeat });
  }, true);
  function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
  function remembered() { try { return localStorage.getItem(storageKey); } catch { return null; } }
  function remember(value) { try { localStorage.setItem(storageKey, value); } catch { /* Private browsing/storage disabled. */ } }
  function load(state) {
    if (!state.revision || !/^[a-f0-9]{16}$/.test(state.revision)) return;
    if (typeof state.entry !== 'string' || state.entry.split('/').some(p => p === '..' || p === '.')) return;
    current = state.revision;
    runtimeConsole.clear();
    memoryMonitor.clear();
    const entry = state.entry.split('/').map(encodeURIComponent).join('/');
    const frameUrl = new URL('bundle/' + current + '/' + entry, base);
    frameUrl.hash = new URLSearchParams({ 'lvgl-go-parent': location.origin }).toString();
    resetLoading();
    const hardware = state.hardware;
    const startupImages = new Set();
    if (hardware && Number.isInteger(hardware.initial) && Array.isArray(hardware.targets) && hardware.targets.every(target => target && typeof target.name === 'string')) {
      fixedDownloadPlan = true;
      for (const target of hardware.targets) if (typeof target.image === 'string') startupImages.add(target.image);
      const remembered = hardware.targets.findIndex(target => target.name === selectedDisplay);
      const target = hardware.targets[remembered >= 0 ? remembered : hardware.initial];
      if (target) {
        const visible = frameMode ?? target.hidden !== true;
        const options = new URLSearchParams(frameUrl.hash.slice(1));
        options.set('lvgl-go-display', target.name);
        options.set('lvgl-go-frame', visible ? '1' : '0');
        frameUrl.hash = options.toString();
      }
    }
    for (const [file, size] of Object.entries(state.downloadBytes || {})) {
      const core = /\.(wasm|data)$/i.test(file), frame = /(?:^|\/)lvgl-go-overlay\/frame-\d+\.(png|jpe?g|webp|gif|svg)$/i.test(file);
      if (!Number.isSafeInteger(size) || size <= 0 || (!core && !frame) || file.startsWith('/') || file.includes('\\') || file.split('/').some(p => p === '..' || p === '.')) continue;
      const url = new URL('bundle/' + current + '/' + file.split('/').map(encodeURIComponent).join('/'), base);
      downloads.set(url.href, { size, loaded: 0, done: false, active: core || frame && (!fixedDownloadPlan || startupImages.has(file)) });
    }
    downloadProgress();
    $('loading').hidden = false;
    $('ui').setAttribute('aria-busy', 'true');
    $('ui').src = frameUrl.href;
    $('ui').style.display = 'block'; $('waiting').hidden = true;
  }
  function update(state) {
    if (state.protocol !== 1) { connection(false); $('status').textContent = 'Unsupported preview protocol'; return; }
    connection(true);
    const labels = { idle: 'Waiting for a build', building: 'Building…', ready: 'Up to date', error: state.message || 'Build failed · showing previous UI' };
    $('status').textContent = labels[state.status] || 'Connecting…';
    if (state.revision && state.revision !== current) load(state);
  }
  function clearConnection() {
    viewControls.close();
    connecting?.abort(); connecting = null;
    stopUpdates?.(); stopUpdates = null;
    connection(false);
    current = null; base = null; frameMode = null; selectedDisplay = null;
    runtimeConsole.clear();
    memoryMonitor.clear();
    resetLoading();
    $('loading').hidden = true;
    $('ui').setAttribute('aria-busy', 'false');
    $('ui').src = 'about:blank'; $('ui').style.display = 'none'; $('waiting').hidden = false;
  }
  function closeConnection() { connectionGeneration++; clearConnection(); }
  async function connect(value) {
    const generation = ++connectionGeneration;
    clearConnection();
    connection(false, 'Connecting…');
    const request = new AbortController(); connecting = request;
    try {
      const parsed = LVGLGoSession.parseSession(value, location.origin);
      const localPreview = parsed.sameOrigin && new URL(parsed.base).protocol === 'http:';
      $('back').hidden = localPreview;
      $('brand').href = localPreview ? parsed.path : '/app/';
      $('home').hidden = true; $('player').hidden = false; document.body.classList.add('playing');
      $('status').textContent = 'Connecting…';
      $('loading-label').textContent = 'Connecting…'; $('loading').hidden = false;
      notice('Connecting…');
      remember(parsed.base); $('reconnect').hidden = false;
      const state = await LVGLGoUpdates.connectSession(parsed.base, { signal: request.signal, onRetry: () => {
        if (generation === connectionGeneration) {
          notice('Waiting for the preview address… Retrying automatically.');
          $('loading-label').textContent = 'Waiting for the preview…';
        }
      } }, globalThis);
      if (generation !== connectionGeneration) return;
      connecting = null;
      base = parsed.base;
      remember(parsed.base); $('reconnect').hidden = false;
      history.replaceState(null, '', localPreview ? parsed.path : '/app/#session=' + encodeURIComponent(parsed.base));
      $('home').hidden = true; $('player').hidden = false; document.body.classList.add('playing');
      $('loading').hidden = true;
      notice(''); update(state);
      stopUpdates = LVGLGoUpdates.watchSession(base, state.transport, update, () => { connection(false); $('status').textContent = 'Reconnecting…'; });
    } catch (error) { if (generation === connectionGeneration) {
      connecting = null; connection(false);
      $('loading').hidden = true; $('player').hidden = true; $('home').hidden = false; document.body.classList.remove('playing');
      notice(error.message || String(error), true);
    } }
  }
  function stopScan() {
    scanGeneration++; cancelAnimationFrame(scanFrame);
    stream?.getTracks().forEach(track => track.stop()); stream = null;
    $('camera').srcObject = null;
  }
  async function scan() {
    const generation = ++scanGeneration;
    try {
      if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Camera scanning needs trusted HTTPS. Open LVGL Go using its HTTPS address and allow camera access.');
      const acquired = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (generation !== scanGeneration) { acquired.getTracks().forEach(track => track.stop()); return; }
      stream = acquired; $('camera').srcObject = stream;
      $('scanner').showModal(); await $('camera').play();
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d', { willReadFrequently: true });
      let last = 0;
      function tick(time) {
        if (!stream || generation !== scanGeneration) return;
        const video = $('camera');
        if (time - last > 180 && video.readyState >= 2 && video.videoWidth && video.videoHeight) {
          last = time;
          const scale = Math.min(1, 720 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const data = context.getImageData(0, 0, canvas.width, canvas.height);
          const code = jsQR(data.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' });
          if (code) { stopScan(); $('scanner').close(); $('url').value = code.data; void connect(code.data); return; }
        }
        scanFrame = requestAnimationFrame(tick);
      }
      scanFrame = requestAnimationFrame(tick);
    } catch (error) { stopScan(); if ($('scanner').open) $('scanner').close(); notice(error.message || 'Camera unavailable. Paste the preview link instead.', true); }
  }
  $('connect').onsubmit = event => { event.preventDefault(); void connect($('url').value.trim()); };
  $('scan').onclick = scan;
  $('cancel-scan').onclick = () => { stopScan(); $('scanner').close(); };
  $('scanner').addEventListener('close', stopScan);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { stopScan(); if ($('scanner').open) $('scanner').close(); } else focusUI(); });
  $('reconnect').onclick = () => { const previous = remembered(); if (previous) void connect(previous); };
  $('back').onclick = () => { closeConnection(); $('player').hidden = true; $('home').hidden = false; document.body.classList.remove('playing'); history.replaceState(null, '', '/app/'); };
  addEventListener('offline', () => {
    // Losing internet access does not necessarily interrupt a LAN session.
    if (base && new URL(base).protocol === 'http:') return;
    connection(false); if (base) $('status').textContent = 'Reconnecting…';
  });
  addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; });
  $('install').onclick = async () => {
    if (installPrompt) { await installPrompt.prompt(); installPrompt = null; }
    else $('install-dialog').showModal();
  };
  $('close-install').onclick = () => $('install-dialog').close();
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('install').hidden = installed || !isSecureContext; $('install-help').hidden = installed || !isSecureContext;
  $('scan').hidden = !isSecureContext;
  $('reconnect').hidden = !remembered();
  if (!isSecureContext) notice('Local HTTP preview. Open the extension’s pairing link or scan its QR code with your phone’s camera. App installation and the browser camera scanner require HTTPS.');
  if (isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => notice('The preview works, but the offline launcher could not be saved.'));
  const localPath = new URL(location.origin).protocol === 'http:' && /^\/s\/[a-f0-9]{48}\/(?:index\.html)?$/.test(location.pathname)
    ? location.pathname.replace(/index\.html$/, '') : null;
  const initial = localPath || new URLSearchParams(location.hash.slice(1)).get('session');
  if (initial) void connect(initial);
  else $('home').hidden = false;
})();
