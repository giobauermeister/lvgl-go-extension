/* Touch controls shared by live and exported previews. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LVGLGoView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function install(doc = document, focus = () => {}, closeMenus = () => {}) {
    const $ = id => doc.getElementById(id);
    const panel = $('view-panel'), toggle = $('view-toggle');
    const isOpen = () => !panel.hidden;
    function fit() {
      const env = doc.defaultView;
      if (!isOpen() || !env) return;
      const viewport = env.visualViewport;
      const bottom = (viewport?.offsetTop || 0) + (viewport?.height || env.innerHeight);
      panel.style.maxHeight = Math.max(0, Math.floor(bottom - toggle.getBoundingClientRect().bottom - 20)) + 'px';
    }
    function close(restore = false) {
      const wasOpen = isOpen();
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      if (wasOpen) doc.documentElement.style.setProperty('--player-touch-action', $('screen-menu')?.hidden === false || $('display-menu')?.hidden === false ? 'pan-y' : 'none');
      if (restore) focus();
    }
    close();
    toggle.onclick = () => {
      if (isOpen()) { close(true); return; }
      closeMenus();
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      doc.documentElement.style.setProperty('--player-touch-action', 'pan-y');
      fit();
    };
    doc.defaultView?.addEventListener('resize', fit);
    doc.defaultView?.visualViewport?.addEventListener('resize', fit);
    if (doc.defaultView?.ResizeObserver && $('preview-controls')) new doc.defaultView.ResizeObserver(fit).observe($('preview-controls'));
    return { isOpen, close };
  }
  return { install };
});
