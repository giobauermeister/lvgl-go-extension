/* Runtime measurements stay in bytes; no simulated architecture multipliers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LVGLGoMemory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const numeric = ['used', 'peak', 'baseline', 'blocks', 'failures', 'bookkeeping', 'time'];
  function valid(sample) {
    if (sample?.pool != null && (!['total', 'used', 'free', 'largest', 'peak', 'fragmentation'].every(key => Number.isSafeInteger(sample.pool[key]) && sample.pool[key] >= 0) ||
      sample.pool.used + sample.pool.free !== sample.pool.total || sample.pool.largest > sample.pool.free || sample.pool.fragmentation > 100 || sample.pool.peak < sample.pool.used)) return false;
    return sample && numeric.every(key => Number.isSafeInteger(sample[key]) && sample[key] >= 0) &&
      sample.peak >= sample.used && sample.peak >= sample.baseline && typeof sample.complete === 'boolean' &&
      [32, 64].includes(sample.pointerBits) && [1, 8, 16, 24, 32].includes(sample.colorDepth);
  }
  const bytes = value => (value / 1024).toFixed(1) + ' KiB';
  const exact = value => value.toLocaleString() + ' B';
  function install(doc = document, focus = () => {}) {
    const $ = id => doc.getElementById(id), popup = $('memory-popup'), toggle = $('memory-toggle');
    const history = [];
    let latest = null, names = [], stopped = false;
    let drag = null, position = null;
    const heading = $('memory-drag'), env = doc.defaultView;
    const desktop = env?.matchMedia?.('(hover: hover) and (pointer: fine)');
    function place() {
      if (popup.hidden || !position) return;
      if (!desktop?.matches) {
        for (const side of ['left', 'top', 'right', 'bottom']) popup.style[side] = '';
        return;
      }
      const bounds = popup.parentElement.getBoundingClientRect(), box = popup.getBoundingClientRect();
      position.x = Math.max(8, Math.min(position.x, bounds.width - box.width - 8));
      position.y = Math.max(8, Math.min(position.y, bounds.height - box.height - 8));
      popup.style.left = position.x + 'px'; popup.style.top = position.y + 'px';
      popup.style.right = 'auto'; popup.style.bottom = 'auto';
    }
    function endDrag(event) {
      if (!drag || event && event.pointerId !== drag.id) return;
      const id = drag.id; drag = null;
      popup.classList.toggle('dragging', false);
      if (heading.hasPointerCapture?.(id)) heading.releasePointerCapture(id);
      focus();
    }
    if (heading && env) {
      heading.addEventListener('pointerdown', event => {
        if (!desktop?.matches || event.pointerType !== 'mouse' || event.button !== 0 || event.target.closest('button,input,a')) return;
        const box = popup.getBoundingClientRect(), bounds = popup.parentElement.getBoundingClientRect();
        drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.left - bounds.left, top: box.top - bounds.top };
        heading.setPointerCapture(event.pointerId);
        popup.classList.toggle('dragging', true); event.preventDefault();
      });
      heading.addEventListener('pointermove', event => {
        if (drag?.id !== event.pointerId) return;
        position = { x: drag.left + event.clientX - drag.x, y: drag.top + event.clientY - drag.y };
        place(); event.preventDefault();
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) heading.addEventListener(type, endDrag);
      env.addEventListener('resize', place);
      env.visualViewport?.addEventListener('resize', place);
      desktop?.addEventListener('change', () => { endDrag(); place(); });
      if (env.ResizeObserver) {
        const observer = new env.ResizeObserver(place);
        observer.observe(popup); observer.observe(popup.parentElement);
      }
    }
    popup.hidden = true;
    toggle.setAttribute('aria-checked', 'false');
    function render() {
      if (popup.hidden) return;
      if (!latest) { $('memory-state').textContent = 'Waiting for runtime measurements…'; return; }
      const sample = latest;
      const failures = sample.failures ? sample.failures + ' allocation failure(s)' : '';
      $('memory-state').textContent = !sample.complete ? 'Tracking capacity exceeded · measurements incomplete' : stopped ? 'Runtime stopped · ' + (failures || 'last measurement') : failures || 'Live allocation requests';
      $('memory-state').classList.toggle('error', !sample.complete || sample.failures > 0);
      $('memory-screen').textContent = names[sample.screen] || 'Current screen';
      $('memory-used').textContent = exact(sample.used);
      $('memory-peak').textContent = exact(sample.peak);
      $('memory-delta').textContent = (sample.used >= sample.baseline ? '+' : '−') + exact(Math.abs(sample.used - sample.baseline));
      $('memory-blocks').textContent = String(sample.blocks);
      $('memory-build').textContent = 'WASM' + sample.pointerBits + ' · ' + sample.colorDepth + '-bit color' + (sample.pool ? ' · LVGL pool' : ' · C allocator');
      $('memory-pool').hidden = !sample.pool;
      if (sample.pool) {
        $('memory-pool-used').textContent = exact(sample.pool.used);
        $('memory-pool-free').textContent = exact(sample.pool.free);
        $('memory-pool-largest').textContent = exact(sample.pool.largest);
        $('memory-pool-frag').textContent = sample.pool.fragmentation + '%';
      }
      const budgetKiB = Number($('memory-budget').value), budget = Number.isSafeInteger(budgetKiB) && budgetKiB > 0 && budgetKiB <= 4194304 ? budgetKiB * 1024 : 0;
      const maximum = Math.max(1024, budget, ...history.map(item => Math.max(item.peak, item.pool?.peak || 0))) * 1.08;
      const y = value => 130 - value / maximum * 120;
      const points = key => history.map((item, i) => (490 - (history.length - 1 - i) / 179 * 480).toFixed(1) + ',' + y(key(item)).toFixed(1)).join(' ');
      $('memory-chart-line').setAttribute('points', points(item => item.pool?.used ?? item.used));
      $('memory-chart-peak').setAttribute('points', points(item => item.pool?.peak ?? item.peak));
      $('memory-chart-current').setAttribute('cy', y(sample.pool?.used ?? sample.used));
      $('memory-chart-max').textContent = bytes(maximum);
      $('memory-chart-caption').textContent = sample.pool ? 'LVGL pool use · live / peak' : 'Requested bytes · live / peak';
      $('memory-chart-budget').setAttribute('visibility', budget ? 'visible' : 'hidden');
      $('memory-chart-budget').setAttribute('y1', y(budget)); $('memory-chart-budget').setAttribute('y2', y(budget));
      const current = sample.pool?.used ?? sample.used, peak = sample.pool?.peak ?? sample.peak;
      $('memory-budget-status').classList.toggle('error', !!budget && peak > budget);
      $('memory-budget-status').textContent = !budget ? '' : current > budget ? 'Live usage exceeds this reference budget.' : peak > budget ? 'Recorded peak exceeds this reference budget.' : sample.pool ? 'Reference budget for this preview build.' : 'Requested bytes only; allocator overhead also needs space.';
    }
    function append(sample) {
      if (!valid(sample)) return;
      latest = sample;
      history.push(sample); if (history.length > 180) history.shift();
      render();
    }
    function clear() {
      latest = null; stopped = false; history.length = 0;
      for (const id of ['memory-used', 'memory-peak', 'memory-delta', 'memory-blocks']) $(id).textContent = '—';
      $('memory-chart-line').setAttribute('points', '');
      $('memory-chart-peak').setAttribute('points', '');
      $('memory-chart-current').setAttribute('cy', '-10');
      $('memory-chart-budget').setAttribute('visibility', 'hidden');
      $('memory-pool').hidden = true;
      $('memory-build').textContent = ''; $('memory-budget-status').textContent = '';
      $('memory-state').classList.toggle('error', false);
      names = []; $('memory-screen').textContent = 'Current screen';
      render();
    }
    function screens(value) { names = Array.isArray(value) ? value : []; render(); }
    toggle.onclick = () => {
      popup.hidden = !popup.hidden;
      if (popup.hidden) { endDrag(); $('memory-budget').blur?.(); }
      toggle.setAttribute('aria-checked', String(!popup.hidden)); render(); place(); focus();
    };
    $('memory-close').onclick = () => { popup.hidden = true; endDrag(); $('memory-budget').blur?.(); toggle.setAttribute('aria-checked', 'false'); focus(); };
    $('memory-budget').oninput = render;
    return { append, clear, screens, stop() { stopped = true; render(); } };
  }
  return { valid, install };
});
