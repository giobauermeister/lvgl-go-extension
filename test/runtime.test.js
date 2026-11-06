const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

test('C runtime creates the selected screen and preserves screens loaded by custom init or permanent exports', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'emscripten.h'), 'static void emscripten_set_main_loop(void (*frame)(void), int fps, int forever) { frame(); }\n');
  await mkdir(path.join(directory, 'SDL2'));
  await writeFile(path.join(directory, 'SDL2/SDL.h'), `
#include <assert.h>
#include <string.h>
#define SDL_HINT_RENDER_DRIVER "SDL_RENDER_DRIVER"
static int renderer_preferred;
static int SDL_SetHint(const char * name, const char * value) {
  assert(!strcmp(name, SDL_HINT_RENDER_DRIVER) && !strcmp(value, "opengles2"));
  renderer_preferred = 1; return 1;
}
`);
  await writeFile(path.join(directory, 'lvgl.h'), `
#pragma once
#include <stddef.h>
#include <stdio.h>
typedef struct { int id; } lv_obj_t;
typedef int lv_display_t;
typedef int lv_indev_t;
typedef int lv_group_t;
static lv_obj_t empty = {0}, custom = {1}, permanent = {2}, created = {3};
static lv_obj_t * active = &empty;
static int device;
static void lv_init(void) {}
static void lv_timer_handler(void) {}
static lv_display_t * lv_sdl_window_create(int w, int h) { assert(renderer_preferred); return &device; }
static lv_group_t * lv_group_create(void) { return &device; }
static void lv_group_set_default(lv_group_t * group) {}
static void lv_indev_set_group(lv_indev_t * indev, lv_group_t * group) {}
static lv_indev_t * lv_sdl_mouse_create(void) { return &device; }
static lv_indev_t * lv_sdl_mousewheel_create(void) { return &device; }
static lv_indev_t * lv_sdl_keyboard_create(void) { return &device; }
static lv_obj_t * lv_screen_active(void) { return active; }
static void lv_screen_load(lv_obj_t * screen) { active = screen; printf("loaded:%d\\n", screen->id); }
`);
  await writeFile(path.join(directory, 'test_ui.h'), `
static lv_obj_t * permanent_screen = &permanent;
static void test_ui_init(const char * assets) {
#ifdef TEST_CUSTOM_LOADS
  lv_screen_load(&custom);
#endif
}
static lv_obj_t * selected_create(void) { puts("created"); return &created; }
void lvgl_go_track_screen(lv_obj_t * screen, lv_obj_t * (*create)(void)) {}
void lvgl_go_screens_update(void) {}
void lvgl_go_display_init(lv_display_t * display) {}
void lvgl_go_memory_baseline(void) {}
`);
  const variants = [
    { defines: ['UI_START_SCREEN=selected_create'], expected: 'created\nloaded:3\n' },
    { defines: ['UI_START_SCREEN=selected_create', 'TEST_CUSTOM_LOADS'], expected: 'loaded:1\n' },
    { defines: ['UI_INITIAL_SCREEN=permanent_screen', 'UI_START_SCREEN=selected_create'], expected: 'loaded:2\n' }
  ];
  for (const [index, variant] of variants.entries()) {
    const binary = path.join(directory, 'startup-' + index);
    await run('cc', [path.join(__dirname, '..', 'runtime', 'main.c'), '-I', directory,
      '-DUI_HEADER="test_ui.h"', '-DUI_INIT=test_ui_init', '-DUI_ASSET_PATH=""', '-DUI_WIDTH=1168', '-DUI_HEIGHT=656',
      ...variant.defines.map(value => '-D' + value), '-o', binary]);
    assert.equal((await run(binary)).stdout, variant.expected);
  }
});

test('C screen switching preserves permanent/borrowed screens and releases temporary screens safely', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-switching-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'emscripten.h'), '#define EMSCRIPTEN_KEEPALIVE\n');
  await writeFile(path.join(directory, 'lvgl.h'), `
#pragma once
#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>
typedef struct lv_obj_t lv_obj_t;
typedef struct { lv_obj_t * target; void * user; } lv_event_t;
typedef struct { void (*callback)(lv_event_t *); void * user; } lv_event_dsc_t;
struct lv_obj_t { bool valid; lv_event_dsc_t descriptor; uint32_t events; };
#define LV_EVENT_DELETE 1
lv_obj_t * lv_screen_active(void);
void lv_screen_load(lv_obj_t * screen);
lv_obj_t * lv_display_get_screen_prev(void * display);
lv_obj_t * lv_display_get_screen_loading(void * display);
void * lv_event_get_user_data(lv_event_t * event);
lv_obj_t * lv_event_get_target_obj(lv_event_t * event);
void lv_obj_add_event_cb(lv_obj_t * obj, void (*cb)(lv_event_t *), int event, void * user);
uint32_t lv_obj_get_event_count(lv_obj_t * obj);
lv_event_dsc_t * lv_obj_get_event_dsc(lv_obj_t * obj, uint32_t index);
void (*lv_event_dsc_get_cb(lv_event_dsc_t * descriptor))(lv_event_t *);
void * lv_event_dsc_get_user_data(lv_event_dsc_t * descriptor);
void lv_obj_delete(lv_obj_t * obj);
bool lv_obj_is_valid(const lv_obj_t * obj);
`);
  await writeFile(path.join(directory, 'registry.h'), `
extern lv_obj_t * permanent;
extern lv_obj_t * first_create(void);
extern lv_obj_t * second_create(void);
static lvgl_go_screen_entry_t lvgl_go_screen_entries[] = {
  {NULL, &permanent, NULL}, {first_create, NULL, NULL}, {second_create, NULL, NULL}
};
static const int lvgl_go_screen_count = 3;
static const char lvgl_go_screen_labels[] = "[\\"Permanent\\",\\"First\\",\\"Second\\"]";
extern lv_obj_t * __real_first_create(void);
extern lv_obj_t * __real_second_create(void);
lv_obj_t * __wrap_first_create(void) {
  lv_obj_t * screen = __real_first_create(); lvgl_go_observe_screen(screen, first_create); return screen;
}
lv_obj_t * __wrap_second_create(void) {
  lv_obj_t * screen = __real_second_create(); lvgl_go_observe_screen(screen, second_create); return screen;
}
`);
  await writeFile(path.join(directory, 'constructors.c'), `
#include "lvgl.h"
extern int first_calls;
extern bool fail_create;
lv_obj_t * allocate(void);
lv_obj_t * first_create(void) { first_calls++; return fail_create ? NULL : allocate(); }
lv_obj_t * second_create(void) { return allocate(); }
`);
  await writeFile(path.join(directory, 'switching.c'), `
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "screens.h"
const char * lvgl_go_screen_list(void);
int lvgl_go_screen_current(void);
int lvgl_go_select_screen(int index);
static lv_obj_t objects[32];
static int used, deleted;
int first_calls;
bool fail_create;
lv_obj_t * permanent;
static lv_obj_t * active, * unloading, * loading;
lv_obj_t * allocate(void) { lv_obj_t * obj = &objects[used++]; obj->valid = true; return obj; }
lv_obj_t * first_create(void);
lv_obj_t * second_create(void);
lv_obj_t * lv_screen_active(void) { return active; }
void lv_screen_load(lv_obj_t * screen) { active = screen; }
lv_obj_t * lv_display_get_screen_prev(void * display) { (void)display; return unloading; }
lv_obj_t * lv_display_get_screen_loading(void * display) { (void)display; return loading; }
void * lv_event_get_user_data(lv_event_t * event) { return event->user; }
lv_obj_t * lv_event_get_target_obj(lv_event_t * event) { return event->target; }
void lv_obj_add_event_cb(lv_obj_t * obj, void (*cb)(lv_event_t *), int event, void * user) {
  (void)event; assert(obj->events == 0); obj->descriptor = (lv_event_dsc_t){cb, user}; obj->events++;
}
uint32_t lv_obj_get_event_count(lv_obj_t * obj) { return obj->events; }
lv_event_dsc_t * lv_obj_get_event_dsc(lv_obj_t * obj, uint32_t index) { assert(index < obj->events); return &obj->descriptor; }
void (*lv_event_dsc_get_cb(lv_event_dsc_t * descriptor))(lv_event_t *) { return descriptor->callback; }
void * lv_event_dsc_get_user_data(lv_event_dsc_t * descriptor) { return descriptor->user; }
void lv_obj_delete(lv_obj_t * obj) {
  assert(obj->valid); lv_event_t event = {obj, obj->descriptor.user};
  if(obj->descriptor.callback) obj->descriptor.callback(&event);
  obj->valid = false; deleted++;
}
bool lv_obj_is_valid(const lv_obj_t * obj) { return obj && obj->valid; }
int main(void) {
  permanent = allocate(); active = permanent;
  assert(!lvgl_go_select_screen(-1)); assert(!lvgl_go_select_screen(99));
#ifdef TEST_EMPTY
  assert(strcmp(lvgl_go_screen_list(), "[]") == 0);
  assert(lvgl_go_screen_current() == -1);
  assert(!lvgl_go_select_screen(0)); lvgl_go_screens_update();
#else
  assert(lvgl_go_screen_current() == 0);
  assert(lvgl_go_select_screen(1)); lv_obj_t * first = active;
  assert(first_calls == 1 && lvgl_go_screen_current() == 1);
  assert(lvgl_go_select_screen(1) && first_calls == 1);
  assert(lvgl_go_select_screen(2));
  unloading = first; lvgl_go_screens_update(); assert(first->valid);
  unloading = NULL; loading = first; lvgl_go_screens_update(); assert(first->valid);
  loading = NULL; lvgl_go_screens_update(); assert(!first->valid && deleted == 1);
  assert(lvgl_go_select_screen(0)); lvgl_go_screens_update();
  assert(permanent->valid && deleted == 2);
  assert(lvgl_go_select_screen(1) && first_calls == 2);
  lv_obj_delete(active); active = permanent; lvgl_go_screens_update();
  assert(deleted == 3); /* Project already deleted it: never delete twice. */
  assert(lvgl_go_select_screen(1) && first_calls == 3);
  lv_obj_t * borrowed = allocate(); active = borrowed; lvgl_go_screens_update();
  assert(deleted == 4 && lvgl_go_screen_current() == -1);
  assert(lvgl_go_select_screen(0)); lvgl_go_screens_update();
  assert(borrowed->valid && permanent->valid && deleted == 4);
  fail_create = true; assert(!lvgl_go_select_screen(1));
  assert(active == permanent && permanent->valid);
  fail_create = false; first = first_create(); active = first;
  /* Project navigation is identified even before the picker owns any instance. */
  assert(lvgl_go_screen_current() == 1);
  int calls = first_calls;
  assert(lvgl_go_select_screen(1) && first_calls == calls);
  lvgl_go_screens_update(); assert(first->valid);
  active = permanent; lvgl_go_screens_update(); assert(first->valid);
  lv_obj_t * other_first = first_create(); active = other_first;
  assert(lvgl_go_screen_current() == 1);
  active = first; assert(lvgl_go_screen_current() == 1);
  lv_obj_delete(other_first); assert(lvgl_go_screen_current() == 1);
  active = second_create(); assert(lvgl_go_screen_current() == 2);
  lvgl_go_screens_update(); assert(first->valid && active->valid);
  active = first;
  lvgl_go_track_screen(first, first_create); assert(lvgl_go_screen_current() == 1);
  assert(lvgl_go_select_screen(0)); lvgl_go_screens_update(); assert(!first->valid);
#endif
  puts("ok");
}
`);
  for (const empty of [false, true]) {
    const binary = path.join(directory, empty ? 'empty' : 'switching');
    await run('cc', ['-std=c99', path.join(__dirname, '../runtime/screens.c'), path.join(directory, 'switching.c'), path.join(directory, 'constructors.c'),
      '-I', directory, '-I', path.join(__dirname, '../runtime'),
      ...(empty ? ['-DTEST_EMPTY'] : ['-DUI_SCREEN_REGISTRY="registry.h"', '-Wl,--wrap=first_create', '-Wl,--wrap=second_create']), '-o', binary]);
    assert.equal((await run(binary)).stdout, 'ok\n');
  }
});

test('runtime display resizing notifies LVGL and rejects invalid framebuffer sizes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-display-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'emscripten.h'), `
#define EMSCRIPTEN_KEEPALIVE
void test_notified(int width, int height);
#define EM_JS(ret, name, args, ...) ret name args { test_notified(width, height); }
`);
  await writeFile(path.join(directory, 'lvgl.h'), `
#pragma once
#include <stddef.h>
typedef struct { int width, height; } lv_display_t;
typedef struct { lv_display_t * target; } lv_event_t;
#define LV_EVENT_RESOLUTION_CHANGED 1
lv_display_t * lv_event_get_target(lv_event_t * event);
void lv_display_add_event_cb(lv_display_t * display, void (*callback)(lv_event_t *), int code, void * user);
int lv_display_get_original_horizontal_resolution(lv_display_t * display);
int lv_display_get_original_vertical_resolution(lv_display_t * display);
lv_display_t * lv_display_get_default(void);
void lv_display_set_resolution(lv_display_t * display, int width, int height);
`);
  await writeFile(path.join(directory, 'display-test.c'), `
#include <assert.h>
#include "display.h"
int lvgl_go_display_width(void);
int lvgl_go_display_height(void);
int lvgl_go_set_display_size(int width, int height);
static lv_display_t display = {1168,656};
static void (*callback)(lv_event_t *);
static int notifications;
lv_display_t * lv_event_get_target(lv_event_t * event) { return event->target; }
void lv_display_add_event_cb(lv_display_t * d, void (*cb)(lv_event_t *), int code, void * user) { assert(d == &display); assert(code == LV_EVENT_RESOLUTION_CHANGED); callback = cb; }
int lv_display_get_original_horizontal_resolution(lv_display_t * d) { return display.width; }
int lv_display_get_original_vertical_resolution(lv_display_t * d) { return display.height; }
lv_display_t * lv_display_get_default(void) { return &display; }
void lv_display_set_resolution(lv_display_t * d, int w, int h) { assert(d == &display); display.width=w;display.height=h;lv_event_t event={d};callback(&event); }
void test_notified(int w, int h) { assert(w == 1280 && h == 960); notifications++; }
int main(void) {
  lvgl_go_display_init(&display);
  assert(lvgl_go_display_width() == 1168 && lvgl_go_display_height() == 656);
  assert(lvgl_go_set_display_size(1280,960));
  assert(lvgl_go_display_width() == 1280 && lvgl_go_display_height() == 960 && notifications == 1);
  assert(!lvgl_go_set_display_size(0,960));assert(!lvgl_go_set_display_size(-1,960));
  assert(!lvgl_go_set_display_size(8193,1));assert(!lvgl_go_set_display_size(8192,8192));
  assert(notifications == 1 && lvgl_go_display_width() == 1280);
}
`);
  const binary = path.join(directory, 'display-test');
  await run('cc', [path.join(__dirname, '..', 'runtime', 'display.c'), path.join(directory, 'display-test.c'), '-I', directory, '-I', path.join(__dirname, '..', 'runtime'), '-o', binary]);
  await run(binary);
});

test('assertion handler flushes preceding diagnostics before aborting', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lvgl-go-assert-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'assert-test.c'), `
#include <stdio.h>
#include <stdlib.h>
void lvrt_assert_handler_cb(void);
void test_abort(void) { _Exit(73); }
int main(void) {
  fputs("preceding LVGL failure", stdout); /* Deliberately leave stdout buffered. */
  lvrt_assert_handler_cb();
}
`);
  const binary = path.join(directory, 'assert-test');
  await run('cc', [path.join(__dirname, '../runtime/assert.c'), path.join(directory, 'assert-test.c'), '-Dabort=test_abort', '-o', binary]);
  await assert.rejects(run(binary), error => {
    assert.equal(error.code, 73);
    assert.equal(error.stdout, 'preceding LVGL failure');
    assert.match(error.stderr, /LVGL assertion failed/);
    return true;
  });
});
