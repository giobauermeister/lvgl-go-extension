#include <emscripten.h>
#include "screens.h"

typedef struct {
    lv_obj_t * (*create)(void);
    lv_obj_t ** permanent;
    lv_obj_t * instance;
} lvgl_go_screen_entry_t;

#ifdef UI_SCREEN_REGISTRY
#include UI_SCREEN_REGISTRY
#else
static lvgl_go_screen_entry_t lvgl_go_screen_entries[] = {{ NULL, NULL, NULL }};
static const int lvgl_go_screen_count = 0;
static const char lvgl_go_screen_labels[] = "[]";
#endif

#ifdef __EMSCRIPTEN__
EM_JS(void, screen_changed, (int index), {
    Module['lvglGoScreenChanged']?.(index);
});
#else
static void screen_changed(int index) { (void)index; }
#endif

static void screen_deleted(lv_event_t * event)
{
    lvgl_go_screen_entry_t * entry = lv_event_get_user_data(event);
    if(entry->instance == lv_event_get_target_obj(event)) entry->instance = NULL;
}

static lvgl_go_screen_entry_t * screen_entry(lv_obj_t * screen)
{
    for(uint32_t i = 0; i < lv_obj_get_event_count(screen); i++) {
        lv_event_dsc_t * descriptor = lv_obj_get_event_dsc(screen, i);
        if(lv_event_dsc_get_cb(descriptor) == screen_deleted) return lv_event_dsc_get_user_data(descriptor);
    }
    return NULL;
}

void lvgl_go_observe_screen(lv_obj_t * screen, lv_obj_t * (*create)(void))
{
    if(!screen || screen_entry(screen)) return;
    for(int i = 0; i < lvgl_go_screen_count; i++) {
        lvgl_go_screen_entry_t * entry = &lvgl_go_screen_entries[i];
        if(entry->create != create) continue;
        lv_obj_add_event_cb(screen, screen_deleted, LV_EVENT_DELETE, entry);
        return;
    }
}

void lvgl_go_track_screen(lv_obj_t * screen, lv_obj_t * (*create)(void))
{
    if(!screen) return;
    lvgl_go_observe_screen(screen, create);
    for(int i = 0; i < lvgl_go_screen_count; i++) {
        lvgl_go_screen_entry_t * entry = &lvgl_go_screen_entries[i];
        if(entry->create != create) continue;
        entry->instance = screen;
        return;
    }
}

EMSCRIPTEN_KEEPALIVE const char * lvgl_go_screen_list(void)
{
    return lvgl_go_screen_labels;
}

EMSCRIPTEN_KEEPALIVE int lvgl_go_screen_current(void)
{
    lv_obj_t * active = lv_screen_active();
    if(!active) return -1;
    lvgl_go_screen_entry_t * observed = screen_entry(active);
    for(int i = 0; i < lvgl_go_screen_count; i++) {
        lvgl_go_screen_entry_t * entry = &lvgl_go_screen_entries[i];
        lv_obj_t * screen = entry->permanent ? *entry->permanent : entry->instance;
        if(screen == active || observed == entry) return i;
    }
    return -1;
}

void lvgl_go_screens_update(void)
{
    static int previous = -2;
    lv_obj_t * active = lv_screen_active();
    lv_obj_t * unloading = lv_display_get_screen_prev(NULL);
    lv_obj_t * loading = lv_display_get_screen_loading(NULL);
    for(int i = 0; i < lvgl_go_screen_count; i++) {
        lvgl_go_screen_entry_t * entry = &lvgl_go_screen_entries[i];
        lv_obj_t * screen = entry->instance;
        /* Only release screens created by this runner, after transitions finish.
         * Delete callbacks clear instances if project code already freed them. */
        if(screen && screen != active && screen != unloading && screen != loading) lv_obj_delete(screen);
    }
    int current = lvgl_go_screen_current();
    if(current != previous) { previous = current; screen_changed(current); }
}

EMSCRIPTEN_KEEPALIVE int lvgl_go_select_screen(int index)
{
    if(index < 0 || index >= lvgl_go_screen_count) return 0;
    if(index == lvgl_go_screen_current()) return 1;
    lvgl_go_screen_entry_t * entry = &lvgl_go_screen_entries[index];
    lv_obj_t * screen = entry->permanent ? *entry->permanent : entry->instance;
    if(!screen && entry->create) {
        screen = entry->create();
        lvgl_go_track_screen(screen, entry->create);
    }
    if(!screen || !lv_obj_is_valid(screen)) return 0;
    if(screen != lv_screen_active()) lv_screen_load(screen);
    return 1;
}
