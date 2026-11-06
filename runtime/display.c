#include <emscripten.h>
#include "display.h"

EM_JS(void, lvgl_go_notify_display, (int width, int height), {
    Module['lvglGoDisplayChanged']?.(width, height);
});

static void resolution_changed(lv_event_t * event)
{
    lv_display_t * display = lv_event_get_target(event);
    lvgl_go_notify_display(lv_display_get_original_horizontal_resolution(display),
                    lv_display_get_original_vertical_resolution(display));
}

void lvgl_go_display_init(lv_display_t * display)
{
    lv_display_add_event_cb(display, resolution_changed, LV_EVENT_RESOLUTION_CHANGED, NULL);
}

EMSCRIPTEN_KEEPALIVE int lvgl_go_display_width(void)
{
    return lv_display_get_original_horizontal_resolution(NULL);
}

EMSCRIPTEN_KEEPALIVE int lvgl_go_display_height(void)
{
    return lv_display_get_original_vertical_resolution(NULL);
}

EMSCRIPTEN_KEEPALIVE int lvgl_go_set_display_size(int width, int height)
{
    if(width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > 16 * 1024 * 1024) return 0;
    lv_display_set_resolution(lv_display_get_default(), width, height);
    return 1;
}
