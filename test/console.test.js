const { test } = require('node:test');
const assert = require('node:assert/strict');
const { install } = require('../media/console');

function fixture() {
  const nodes = new Map(), frames = [], events = {};
  let focuses = 0;
  for (const id of ['runtime-console', 'console-output', 'console-toggle', 'console-clear', 'console-resize']) nodes.set(id, {
    hidden: false, style: {}, attributes: {}, children: [], scrollTop: 0, scrollHeight: 200, clientHeight: 200,
    parentElement: { clientHeight: 600 }, getBoundingClientRect: () => ({ height: 200 }),
    setAttribute(name, value) { this.attributes[name] = value; },
    replaceChildren(...rows) { this.children = rows; },
    addEventListener(name, fn) { events[id + ':' + name] = fn; },
    setPointerCapture(id) { this.pointer = id; }
  });
  const api = install({ getElementById: id => nodes.get(id), createElement: () => ({}) },
    { requestAnimationFrame: fn => frames.push(fn) }, () => focuses++);
  return { api, nodes, events, frames, focuses: () => focuses, tick: () => { while (frames.length) frames.shift()(); } };
}

test('console starts hidden, keeps bounded early logs and renders them safely on opening', () => {
  const f = fixture(), output = f.nodes.get('console-output');
  assert(f.nodes.get('runtime-console').hidden);
  assert.equal(f.nodes.get('console-toggle').attributes['aria-checked'], 'false');
  for (let i = 0; i < 510; i++) f.api.append({ level: 'user', text: '<script>' + i, time: 1 });
  f.api.append({ level: 'invalid', text: 'invalid' }); f.api.append({ level: 'error', text: {} });
  assert.equal(output.children.length, 0); assert.equal(f.frames.length, 0);
  f.nodes.get('console-toggle').onclick();
  assert.equal(f.nodes.get('runtime-console').hidden, false);
  assert.equal(output.children.length, 500);
  assert(output.children[0].textContent.endsWith('<script>10'));
  assert.equal(output.children[0].innerHTML, undefined);
  assert.equal(f.nodes.get('console-toggle').attributes['aria-checked'], 'true');
  assert.equal(f.focuses(), 1);
  f.api.append({ level: 'error', text: 'x'.repeat(9000), time: Infinity });
  f.api.append({ level: 'warn', text: 'warning', time: 1 });
  assert.equal(f.frames.length, 1); f.tick();
  assert.equal(output.children.length, 500);
  assert(output.children.at(-2).textContent.endsWith('x'.repeat(8192)));
  assert.equal(output.children.at(-1).className, 'console-line console-warn');
  f.nodes.get('console-toggle').onclick(); assert(f.nodes.get('runtime-console').hidden);
  assert.equal(f.nodes.get('console-toggle').attributes['aria-checked'], 'false');
  f.nodes.get('console-clear').onclick(); assert.equal(output.children.length, 0);
  f.nodes.get('console-toggle').onclick(); assert.equal(output.children.length, 0);
});

test('console follows new output at the bottom and preserves a user scroll position', () => {
  const f = fixture(), output = f.nodes.get('console-output');
  f.nodes.get('console-toggle').onclick();
  f.api.append({ level: 'info', text: 'one' }); f.tick(); assert.equal(output.scrollTop, 200);
  output.scrollTop = 30; output.scrollHeight = 1000;
  f.api.append({ level: 'error', text: 'two' }); f.tick(); assert.equal(output.scrollTop, 30);
});

test('console drag handle captures touch pointers, bounds height and releases navigation focus', () => {
  const f = fixture(), panel = f.nodes.get('runtime-console'), handle = f.nodes.get('console-resize');
  let prevented = 0;
  const pointer = { button: 0, pointerId: 7, clientY: 400, preventDefault() { prevented++; } };
  f.events['console-resize:pointerdown'](pointer); assert.equal(handle.pointer, 7);
  f.events['console-resize:pointermove']({ ...pointer, pointerId: 8, clientY: 0 }); assert.equal(panel.style.height, undefined);
  f.events['console-resize:pointermove']({ ...pointer, clientY: 100 }); assert.equal(panel.style.height, '420px');
  f.events['console-resize:pointermove']({ ...pointer, clientY: 900 }); assert.equal(panel.style.height, '128px');
  f.events['console-resize:pointercancel'](pointer); assert.equal(f.focuses(), 1);
  f.events['console-resize:pointermove']({ ...pointer, clientY: 0 }); assert.equal(panel.style.height, '128px');
  assert.equal(prevented, 3);
});
