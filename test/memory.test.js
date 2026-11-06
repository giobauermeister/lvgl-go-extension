const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, rm } = require('node:fs/promises');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { valid, install } = require('../media/memory');
const run = promisify(execFile);
const sample = { used: 5000, peak: 9000, baseline: 1000, blocks: 4, failures: 0, complete: true, pointerBits: 32, colorDepth: 32, bookkeeping: 262144, time: 1000, screen: 0 };

test('LVGL allocation hooks preserve real allocations, realloc failures, freeing and short-lived peaks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-memory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'emscripten.h'), '#define EMSCRIPTEN_KEEPALIVE\n');
  await writeFile(path.join(root, 'lvgl.h'), `#include <stddef.h>
#define LV_COLOR_DEPTH 16
#define LV_STDLIB_BUILTIN 0
#ifdef TEST_POOL
#define LV_USE_STDLIB_MALLOC 0
typedef struct { size_t total_size, free_size, free_biggest_size, max_used; unsigned char frag_pct; } lv_mem_monitor_t;
void lv_mem_monitor(lv_mem_monitor_t *);
#else
#define LV_USE_STDLIB_MALLOC 1
#endif
`);
  await writeFile(path.join(root, 'backend.c'), `#include <stdlib.h>\n#include "lvgl.h"\n#ifdef TEST_POOL\nvoid lv_mem_monitor(lv_mem_monitor_t * p) { p->total_size=1000; p->free_size=900; p->free_biggest_size=800; p->max_used=150; p->frag_pct=12; }\n#endif\nvoid * lv_malloc_core(size_t size) { return size == 999 ? NULL : malloc(size); }
void * lv_realloc_core(void * p, size_t size) { return size == 999 ? NULL : realloc(p, size); }
void lv_free_core(void * p) { free(p); }`);
  await writeFile(path.join(root, 'driver.c'), `
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <assert.h>
#include "memory.h"
const char * lvgl_go_memory_snapshot(void);
void * lv_malloc_core(size_t);
void * lv_realloc_core(void *, size_t);
void lv_free_core(void *);
int main(void) {
  char * p = lv_malloc_core(10); assert(p); memset(p, 42, 10);
  lvgl_go_memory_baseline();
  void * temporary = lv_malloc_core(100); lv_free_core(temporary);
  p = lv_realloc_core(p, 20); assert(p && p[0] == 42);
  assert(!lv_realloc_core(p, 999)); assert(p[0] == 42);
  assert(!lv_malloc_core(999));
  puts(lvgl_go_memory_snapshot());
  lv_free_core(p); lv_free_core(NULL); puts(lvgl_go_memory_snapshot());
  for(int i = 0; i < 100; i++) { p = lv_malloc_core(15); lv_free_core(p); }
  puts(lvgl_go_memory_snapshot());
  void * slots[16]; for(int i = 0; i < 16; i++) slots[i] = lv_malloc_core(1);
  puts(lvgl_go_memory_snapshot());
  for(int i = 0; i < 16; i++) lv_free_core(slots[i]);
  return 0;
}
`);
  for (const pool of [false, true]) {
  const binary = path.join(root, pool ? 'pool-memory' : 'memory');
  await run('cc', [path.join(__dirname, '../runtime/memory.c'), path.join(root, 'driver.c'), path.join(root, 'backend.c'), '-I', root, '-I', path.join(__dirname, '../runtime'),
    ...(pool ? ['-DTEST_POOL'] : []), '-DLVGL_GO_MEMORY_SLOTS=8', '-Wl,--wrap=lv_malloc_core', '-Wl,--wrap=lv_realloc_core', '-Wl,--wrap=lv_free_core', '-o', binary]);
  const rows = (await run(binary)).stdout.trim().split('\n').map(row => JSON.parse(row));
  assert.deepEqual([rows[0].used, rows[0].peak, rows[0].baseline, rows[0].blocks, rows[0].failures], [20, 110, 10, 1, 2]);
  assert.equal(rows[0].colorDepth, 16); assert([32, 64].includes(rows[0].pointerBits)); assert(rows[0].complete);
  assert.equal(rows[1].used, 0); assert.equal(rows[1].blocks, 0); assert.equal(rows[1].peak, 110);
  assert.equal(rows[2].used, 0); assert(rows[2].complete);
  assert.equal(rows[3].complete, false); assert.equal(rows[3].blocks, 8);
  assert.deepEqual(rows[0].pool, pool ? { total:1000, used:100, free:900, largest:800, peak:150, fragmentation:12 } : null);
  }
});

function fixture(draggable=false) {
  const nodes = new Map(); let focused = 0;
  const ids = ['memory-popup', 'memory-toggle', 'memory-close', 'memory-state', 'memory-screen', 'memory-used', 'memory-peak', 'memory-delta', 'memory-blocks', 'memory-build', 'memory-budget', 'memory-chart-line', 'memory-chart-max', 'memory-chart-caption', 'memory-chart-budget', 'memory-budget-status', 'memory-chart-peak', 'memory-chart-current', 'memory-pool', 'memory-pool-used', 'memory-pool-free', 'memory-pool-largest', 'memory-pool-frag'];
  for (const id of ids) nodes.set(id, { value: '', textContent: '', attributes: {}, classList: { toggle() {} }, setAttribute(name, value) { this.attributes[name] = String(value); } });
  const doc={getElementById:id=>nodes.get(id)}, events={}, bounds={left:50,top:100,width:900,height:700}, desktop={matches:true,addEventListener(type,fn){events['media:'+type]=fn;}};
  if(draggable) {
    const popup=nodes.get('memory-popup');popup.style={};
    popup.parentElement={getBoundingClientRect:()=>bounds};
    popup.getBoundingClientRect=()=>({left:bounds.left+(parseFloat(popup.style.left)||400),top:bounds.top+(parseFloat(popup.style.top)||300),width:380,height:280});
    const heading={addEventListener(type,fn){events[type]=fn;},setPointerCapture(id){this.pointer=id;},hasPointerCapture(id){return this.pointer===id;},releasePointerCapture(){this.pointer=null;}};
    nodes.set('memory-drag',heading);
    doc.defaultView={matchMedia:()=>desktop,addEventListener(type,fn){events['window:'+type]=fn;}};
  }
  const api = install(doc, () => focused++);
  return { api, nodes, events, bounds, desktop, focused: () => focused };
}

test('memory popup retains bounded history while hidden, validates telemetry and labels the real build', () => {
  assert(valid(sample));
  for (const change of [{ used: -1 }, { peak: 2 }, { complete: 'true' }, { pointerBits: 16 }, { colorDepth: 17 }, { used: Infinity }]) assert(!valid({ ...sample, ...change }));
  const f = fixture(); assert(f.nodes.get('memory-popup').hidden);
  assert.equal(f.nodes.get('memory-toggle').attributes['aria-checked'],'false');
  f.api.screens(['source_screen']);
  for (let i = 0; i < 190; i++) f.api.append({ ...sample, used: 5000 + i });
  assert.equal(f.nodes.get('memory-used').textContent, '');
  f.nodes.get('memory-toggle').onclick();
  assert.equal(f.nodes.get('memory-toggle').attributes['aria-checked'],'true');
  assert.equal(f.nodes.get('memory-screen').textContent, 'source_screen');
  assert.equal(f.nodes.get('memory-build').textContent, 'WASM32 · 32-bit color · C allocator');
  assert.equal(f.nodes.get('memory-chart-line').attributes.points.split(' ').length, 180);
  f.nodes.get('memory-budget').value = '1'; f.nodes.get('memory-budget').oninput();
  assert.equal(f.nodes.get('memory-chart-budget').attributes.visibility, 'visible');
  assert.match(f.nodes.get('memory-budget-status').textContent, /exceed/);
  f.api.append({ ...sample, complete: false }); assert.match(f.nodes.get('memory-state').textContent, /incomplete/);
  f.nodes.get('memory-close').onclick(); assert(f.nodes.get('memory-popup').hidden); assert.equal(f.focused(), 2);
  assert.equal(f.nodes.get('memory-toggle').attributes['aria-checked'],'false');
  f.api.clear(); f.nodes.get('memory-toggle').onclick();
  assert.equal(f.nodes.get('memory-used').textContent, '—');
  assert.match(f.nodes.get('memory-state').textContent, /Waiting/);
});


test('pool statistics use the actual allocator and budget warnings include unsampled peaks', () => {
  const f = fixture();
  f.nodes.get('memory-toggle').onclick();
  f.nodes.get('memory-budget').value = '8';
  f.api.append(sample);
  assert.match(f.nodes.get('memory-budget-status').textContent, /Recorded peak exceeds/);
  const pool = { total:65536, used:8192, free:57344, largest:49152, peak:16384, fragmentation:14 };
  f.api.append({ ...sample, pool });
  assert.equal(f.nodes.get('memory-pool').hidden, false);
  assert.equal(f.nodes.get('memory-pool-used').textContent, '8,192 B');
  assert.equal(f.nodes.get('memory-pool-frag').textContent, '14%');
  assert.match(f.nodes.get('memory-build').textContent, /LVGL pool/);
  for (const change of [{ free: 1 }, { largest:60000 }, { fragmentation:101 }, { peak:1 }]) assert(!valid({ ...sample, pool:{ ...pool, ...change } }));
  f.api.stop(); assert.match(f.nodes.get('memory-state').textContent, /Runtime stopped/);
  f.nodes.get('memory-budget').value = '1e308'; f.nodes.get('memory-budget').oninput();
  assert.equal(f.nodes.get('memory-chart-budget').attributes.visibility, 'hidden');
});

test('desktop memory dragging captures the mouse, stays within the player and reclamps after resize', () => {
  const f=fixture(true), popup=f.nodes.get('memory-popup'), heading=f.nodes.get('memory-drag');
  f.nodes.get('memory-toggle').onclick();
  let prevented=0;
  const event={pointerId:7,pointerType:'mouse',button:0,clientX:450,clientY:410,target:{closest:()=>null},preventDefault(){prevented++;}};
  f.events.pointerdown(event);assert.equal(heading.pointer,7);
  f.events.pointermove({...event,clientX:1450,clientY:1410});
  assert.equal(popup.style.left,'512px');assert.equal(popup.style.top,'412px');
  f.bounds.width=500;f.bounds.height=400;f.events['window:resize']();
  assert.equal(popup.style.left,'112px');assert.equal(popup.style.top,'112px');
  f.events.pointerup(event);assert.equal(heading.pointer,null);
  f.events.pointermove({...event,clientX:0,clientY:0});assert.equal(popup.style.left,'112px');
  f.nodes.get('memory-toggle').onclick();f.nodes.get('memory-toggle').onclick();
  assert.equal(popup.style.left,'112px');assert.equal(popup.style.top,'112px');
  f.desktop.matches=false;f.events['media:change']();
  for(const side of ['left','top','right','bottom'])assert.equal(popup.style[side],'');
  assert.equal(prevented,2);
});

test('memory dragging ignores touch, pen, secondary clicks and interactive header controls', () => {
  const f=fixture(true), heading=f.nodes.get('memory-drag');
  f.nodes.get('memory-toggle').onclick();
  const event={pointerId:1,pointerType:'mouse',button:0,target:{closest:()=>null},preventDefault(){throw Error('Unexpected drag');}};
  for(const change of [{pointerType:'touch'},{pointerType:'pen'},{button:2},{target:{closest:()=>({})}}]) f.events.pointerdown({...event,...change});
  f.desktop.matches=false;f.events.pointerdown(event);
  assert.equal(heading.pointer,undefined);
  assert.equal(f.nodes.get('memory-popup').style.left,undefined);
});
