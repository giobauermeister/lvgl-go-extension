const { test } = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('../media/view');

function fixture() {
  const nodes = new Map(), events = {}, styles = new Map();
  let focuses = 0, menusClosed = 0;
  for (const id of ['view-controls', 'view-panel', 'view-toggle', 'memory-toggle', 'console-toggle', 'frame-toggle', 'screen-menu', 'display-menu']) {
    nodes.set(id, { hidden: true, attributes: {}, setAttribute(key, value) { this.attributes[key] = value; },
      addEventListener(type, fn) { events[id + ':' + type] = fn; } });
  }
  const doc = { getElementById: id => nodes.get(id), documentElement: { style: { setProperty: (key, value) => styles.set(key, value) } },
    addEventListener(type, fn) { events[type] = fn; } };
  const api = install(doc, () => focuses++, () => menusClosed++);
  return { nodes, events, styles, api, focuses: () => focuses, menusClosed: () => menusClosed };
}

test('View opens without stealing focus and closes from its button without changing enabled options', () => {
  const f = fixture(), panel = f.nodes.get('view-panel'), toggle = f.nodes.get('view-toggle');
  assert.equal(f.api.isOpen(), false);
  toggle.onclick();
  assert.equal(panel.hidden, false);
  assert.equal(toggle.attributes['aria-expanded'], 'true');
  assert.equal(f.focuses(), 0); assert.equal(f.menusClosed(), 1);
  assert.equal(f.styles.get('--player-touch-action'), 'pan-y');
  f.nodes.get('memory-toggle').attributes['aria-checked'] = 'true';
  assert.equal(f.api.isOpen(), true);
  toggle.onclick();
  assert.equal(f.api.isOpen(), false); assert.equal(f.focuses(), 1);
  assert.equal(f.nodes.get('memory-toggle').attributes['aria-checked'], 'true');
  assert.equal(f.styles.get('--player-touch-action'), 'none');
});

test('closing View preserves touch scrolling for an open screen menu', () => {
  const f = fixture(), toggle = f.nodes.get('view-toggle');
  toggle.onclick(); toggle.onclick();
  assert.equal(f.api.isOpen(), false); assert.equal(f.focuses(), 1);
  toggle.onclick(); f.nodes.get('screen-menu').hidden=false; toggle.onclick();
  assert.equal(f.api.isOpen(),false);
  assert.equal(f.styles.get('--player-touch-action'),'pan-y');
});

test('View fits below its button and updates its available height after rotation', () => {
  const nodes = new Map(), events = {};
  let buttonBottom = 190;
  for (const id of ['view-panel', 'view-toggle', 'memory-toggle', 'console-toggle', 'frame-toggle']) nodes.set(id, {
    hidden: true, style: {}, setAttribute() {}, addEventListener() {}, getBoundingClientRect: () => ({ bottom: buttonBottom })
  });
  const viewport = { height: 320, offsetTop: 0, addEventListener(type, fn) { events['viewport:' + type] = fn; } };
  const env = { innerHeight: 320, visualViewport: viewport, addEventListener(type, fn) { events[type] = fn; } };
  install({ getElementById: id => nodes.get(id), defaultView: env, documentElement: { style: { setProperty() {} } }, addEventListener() {} });
  nodes.get('view-toggle').onclick();
  assert.equal(nodes.get('view-panel').style.maxHeight, '110px');
  viewport.height = 844; buttonBottom = 230; events['viewport:resize']();
  assert.equal(nodes.get('view-panel').style.maxHeight, '594px');
  viewport.height = 100; events.resize();
  assert.equal(nodes.get('view-panel').style.maxHeight, '0px');
});
