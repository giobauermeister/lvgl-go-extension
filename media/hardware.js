/* LVGL Go's browser composition of project-provided hardware artwork. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LVGLGoHardware = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function layout(width, height, frame, availableWidth, availableHeight, mode) {
    const x = frame?.x || 0, y = frame?.y || 0;
    const boundsWidth = frame ? Math.max(frame.width, x + width, ...frame.buttons.map(b => b.x + b.width)) : width;
    const boundsHeight = frame ? Math.max(frame.height, y + height, ...frame.buttons.map(b => b.y + b.height)) : height;
    const ratio = Math.min(mode === 'fit' ? Infinity : 1, availableWidth / boundsWidth, availableHeight / boundsHeight);
    return { x, y, width: boundsWidth, height: boundsHeight, ratio };
  }
  function placement(geometry, availableWidth, availableHeight, pixelRatio = 1, viewportLeft = 0, viewportTop = 0) {
    const dpr = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
    const { x, y, width, height, ratio } = geometry;
    const align = value => Math.round(value * dpr) / dpr;
    // Center the artwork, but align the UI's origin to physical pixels. An odd
    // frame height must not move a native-size canvas onto a half pixel.
    return {
      left: align(viewportLeft + (availableWidth - width * ratio) / 2 + x * ratio) - viewportLeft - x * ratio,
      top: align(viewportTop + (availableHeight - height * ratio) / 2 + y * ratio) - viewportTop - y * ratio
    };
  }
  function install(module, canvas, env, { key, changed, baseUrl }) {
    const document = env.document, stage = document?.getElementById('hardware-stage');
    if (!stage) return null;
    const viewport = document.getElementById('surface'), image = document.getElementById('hardware-image'), buttons = document.getElementById('hardware-buttons');
    const screenHint = document.getElementById('hardware-screen-hint');
    const bundle = new URL('lvgl-go-overlay/', baseUrl || env.location.href);
    const cache = new Map();
    const requests = new AbortController();
    let disposed = false;
    let targets = [], current = -1, width = canvas.width, height = canvas.height;
    const startup = new URLSearchParams((env.location.hash || '').replace(/^#/, ''));
    let running = false, choice = startup.get('lvgl-go-frame') === '1' ? true : startup.get('lvgl-go-frame') === '0' ? false : null, frame = null, rendered = null;
    const requested = () => choice ?? !targets[current]?.overlay?.hidden;
    function state() {
      const overlay = targets[current]?.overlay;
      return { targets: targets.map(t => ({ name: t.name, width: t.width, height: t.height })), current,
        frameAvailable: !!overlay && !cache.get(overlay.image)?.failed, frameVisible: !!overlay && requested() && !cache.get(overlay.image)?.failed };
    }
    function loadAsset(overlay) {
      let asset = cache.get(overlay.image);
      if (!asset) {
        const loader = new env.Image();
        asset = { loader, loaded: false, failed: false, url: null }; cache.set(overlay.image, asset);
        asset.ready = new Promise(resolve => {
          loader.onload = async () => {
            try { if (loader.decode) await loader.decode(); asset.loaded = true; }
            catch { asset.failed = true; }
            refresh(); resolve();
          };
          loader.onerror = () => { asset.failed = true; refresh(); resolve(); };
          // Use the shared fetch stream so image bytes count toward startup.
          // A blob URL lets both image elements share that single download.
          env.fetch(new URL(overlay.image, bundle).href, { credentials: 'omit', signal: requests.signal }).then(async response => {
            if (!response.ok) throw new Error('Frame image unavailable');
            const blob = await response.blob();
            if (disposed) throw new Error('Preview closed');
            asset.url = env.URL.createObjectURL(blob);
            loader.src = asset.url;
          }).catch(loader.onerror);
        });
      }
      return asset;
    }
    function refresh() {
      if (disposed) return;
      const overlay = requested() ? targets[current]?.overlay : null;
      const asset = overlay && loadAsset(overlay);
      frame = overlay && asset.loaded && !asset.failed ? { ...overlay, width: asset.loader.naturalWidth, height: asset.loader.naturalHeight } : null;
      const identity = frame ? current : -1;
      if (identity !== rendered) {
        rendered = identity;
        stage.classList.remove('hardware-hint');
        image.hidden = !frame;
        if (frame) {
          image.src = asset.url;
          image.style.width = frame.width + 'px'; image.style.height = frame.height + 'px';
        }
        buttons.replaceChildren(...(frame?.buttons || []).map(config => {
          const button = document.createElement('button');
          button.type = 'button'; button.tabIndex = -1; button.title = config.help;
          button.setAttribute('aria-label', config.name);
          Object.assign(button.style, { left: config.x + 'px', top: config.y + 'px', width: config.width + 'px', height: config.height + 'px' });
          const release = () => { button.style.backgroundColor = 'transparent'; };
          button.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault(); button.setPointerCapture(event.pointerId);
            button.style.backgroundColor = config.color + '55';
            key({ key: config.key }); canvas.focus({ preventScroll: true });
          });
          for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) button.addEventListener(type, release);
          return button;
        }));
      }
      changed(state());
    }
    viewport.addEventListener('pointerdown', event => {
      if (!running || !frame || event.button !== 0 || event.target === canvas || buttons.contains(event.target)) return;
      event.preventDefault();
      // Restart the brief hint even if another missed tap arrives mid-animation.
      stage.classList.remove('hardware-hint');
      void stage.offsetWidth;
      stage.classList.add('hardware-hint');
      canvas.focus({ preventScroll: true });
    });
    function sync() {
      if (!running) return;
      width = module._lvgl_go_display_width?.() || canvas.width;
      height = module._lvgl_go_display_height?.() || canvas.height;
      if (targets[current]?.width !== width || targets[current]?.height !== height) current = targets.findIndex(t => t.width === width && t.height === height);
      refresh();
    }
    const loaded = env.fetch(new URL('manifest.json', bundle).href, { credentials: 'omit', signal: requests.signal }).then(async response => {
      if (!response.ok) return;
      const data = await response.json();
      if (data.version !== 1 || !Array.isArray(data.targets)) return;
      // The bundle contains normalized metadata; image URLs remain bundle-local.
      if (!data.targets.every(t => typeof t.name === 'string' && Number.isInteger(t.width) && t.width > 0 && Number.isInteger(t.height) && t.height > 0
        && (t.radius === undefined || (Number.isInteger(t.radius) && t.radius >= 0 && t.radius <= 8192))
        && (!t.overlay || (/^frame-\d+\.(png|jpe?g|webp|gif|svg)$/.test(t.overlay.image) && Array.isArray(t.overlay.buttons))))) return;
      if (disposed) return;
      targets = data.targets;
      // Warm every target, including hidden frames, while WASM is starting.
      for (const target of targets) if (target.overlay) loadAsset(target.overlay);
      sync();
    }).catch(() => { /* Older/custom bundles keep the UI-only player. */ });
    env.addEventListener?.('pagehide', event => {
      if (!event.persisted) {
        disposed = true; requests.abort();
        for (const asset of cache.values()) if (asset.url) env.URL.revokeObjectURL(asset.url);
      }
    });
    return {
      viewport, loaded, state, sync,
      async ready() {
        await loaded;
        if (disposed) return;
        running = true;
        const selected = targets.findIndex(target => target.name === startup.get('lvgl-go-display'));
        if (selected >= 0 && module._lvgl_go_set_display_size) {
          current = selected;
          const target = targets[current];
          if (module._lvgl_go_display_width?.() !== target.width || module._lvgl_go_display_height?.() !== target.height) module._lvgl_go_set_display_size(target.width, target.height);
        }
        sync();
        await Promise.all([...cache.values()].map(asset => asset.ready));
        if (disposed) return;
        // Display restoration can select a different target while an image is
        // downloading. Wait for the frame that is actually selected at the end.
        for (;;) {
          sync();
          const overlay = requested() ? targets[current]?.overlay : null;
          const asset = overlay && cache.get(overlay.image);
          await asset?.ready;
          if (overlay !== (requested() ? targets[current]?.overlay : null)) continue;
          if (frame && image.decode) {
            try { await image.decode(); }
            catch { asset.failed = true; refresh(); }
          }
          if (overlay === (requested() ? targets[current]?.overlay : null)) return;
        }
      },
      fit(mode) {
        const availableWidth = viewport.clientWidth || env.innerWidth, availableHeight = viewport.clientHeight || env.innerHeight;
        const geometry = layout(width, height, frame, availableWidth, availableHeight, mode);
        const bounds = viewport.getBoundingClientRect?.();
        const origin = placement(geometry, availableWidth, availableHeight, env.devicePixelRatio, bounds?.left || 0, bounds?.top || 0);
        Object.assign(stage.style, { left: origin.left + 'px', top: origin.top + 'px', width: geometry.width + 'px', height: geometry.height + 'px',
          transform: geometry.ratio === 1 ? 'none' : `scale(${geometry.ratio})` });
        // Radius uses framebuffer pixels; the stage transform scales it with
        // the UI, independently of hardware frame visibility.
        const screenStyle = { left: geometry.x + 'px', top: geometry.y + 'px', width: width + 'px', height: height + 'px',
          borderRadius: (targets[current]?.radius ?? 0) + 'px' };
        Object.assign(canvas.style, screenStyle);
        if (screenHint) Object.assign(screenHint.style, screenStyle);
      },
      handle(data) {
        if (!running) return;
        if (data.type === 'lvgl-go-frame' && typeof data.visible === 'boolean') { choice = data.visible; refresh(); }
        if (data.type === 'lvgl-go-select-display' && Number.isInteger(data.index) && data.index >= 0 && data.index < targets.length && module._lvgl_go_set_display_size) {
          const target = targets[data.index];
          current = data.index;
          module._lvgl_go_set_display_size(target.width, target.height); sync();
        }
      }
    };
  }
  return { layout, placement, install };
});
