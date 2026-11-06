/* Bounded, read-only runtime console shared by live and exported previews. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LVGLGoConsole = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function install(doc = document, env = window, focus = () => {}) {
    const $ = id => doc.getElementById(id);
    const panel = $('runtime-console'), output = $('console-output'), toggle = $('console-toggle'), handle = $('console-resize');
    const lines = [];
    let scheduled = false, drag = null;
    panel.hidden = true;
    toggle.setAttribute('aria-checked', 'false');
    function render() {
      scheduled = false;
      if (panel.hidden) return;
      const bottom = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
      const top = output.scrollTop;
      const rows = lines.map(entry => {
        const row = doc.createElement('div'); row.className = 'console-line console-' + entry.level;
        const time = new Date(entry.time).toLocaleTimeString([], { hour12: false });
        const label = /^\s*\[(trace|info|warn|error|user)\]/i.test(entry.text) ? '' : '[' + entry.level + '] ';
        row.textContent = time + ' ' + label + entry.text;
        return row;
      });
      output.replaceChildren(...rows);
      output.scrollTop = bottom ? output.scrollHeight : top;
    }
    function append(entry) {
      if (!entry || !['trace', 'info', 'warn', 'error', 'user'].includes(entry.level) || typeof entry.text !== 'string') return;
      lines.push({ level: entry.level, text: entry.text.slice(0, 8192), time: Number.isFinite(entry.time) && Math.abs(entry.time) < 8.64e15 ? entry.time : Date.now() });
      if (lines.length > 500) lines.splice(0, lines.length - 500);
      if (!panel.hidden && !scheduled) { scheduled = true; env.requestAnimationFrame(render); }
    }
    function clear() { lines.length = 0; output.replaceChildren(); }
    toggle.onclick = () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-checked', String(!panel.hidden));
      if (!panel.hidden) { output.scrollTop = output.scrollHeight; render(); }
      focus();
    };
    $('console-clear').onclick = () => { clear(); focus(); };
    function resize(y) {
      const maximum = Math.max(128, panel.parentElement.clientHeight * .7);
      panel.style.height = Math.min(maximum, Math.max(128, drag.height + drag.y - y)) + 'px';
    }
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { id: event.pointerId, y: event.clientY, height: panel.getBoundingClientRect().height };
      handle.setPointerCapture(event.pointerId); event.preventDefault();
    });
    handle.addEventListener('pointermove', event => { if (drag?.id === event.pointerId) { resize(event.clientY); event.preventDefault(); } });
    function end(event) {
      if (drag?.id !== event.pointerId) return;
      drag = null; focus();
    }
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    return { append, clear };
  }
  return { install };
});
