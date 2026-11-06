#include <emscripten.h>
#include <SDL2/SDL.h>
#include "lvgl.h"
#include UI_HEADER
#include "screens.h"
#include "display.h"
#include "memory.h"

static void frame(void)
{
    lv_timer_handler();
    lvgl_go_screens_update();
}

int main(void)
{
    /* Pro's precompiled SDL driver requests software rendering. Prefer WebGL
     * for presenting its framebuffer, avoiding another full CPU alpha blend.
     * SDL tries its normal renderer selection if this backend is unavailable. */
    SDL_SetHint(SDL_HINT_RENDER_DRIVER, "opengles2");
    lv_init();
    lv_display_t * display = lv_sdl_window_create(UI_WIDTH, UI_HEIGHT);
    if(!display) return 1;
    lv_group_t * group = lv_group_create();
    lv_group_set_default(group);
    lv_indev_set_group(lv_sdl_mouse_create(), group);
    lv_indev_set_group(lv_sdl_mousewheel_create(), group);
    lv_indev_set_group(lv_sdl_keyboard_create(), group);
    lv_obj_t * default_screen = lv_screen_active();
    lvgl_go_memory_baseline();
    UI_INIT(UI_ASSET_PATH);
    lvgl_go_display_init(display);
#ifdef UI_INITIAL_SCREEN
    /* Custom initialization owns screen selection when it changes the active screen. */
    if(lv_screen_active() == default_screen && UI_INITIAL_SCREEN != NULL) {
        lv_screen_load(UI_INITIAL_SCREEN);
    }
#else
    (void)default_screen;
#endif
#ifdef UI_START_SCREEN
    if(lv_screen_active() == default_screen) {
        lv_obj_t * screen = UI_START_SCREEN();
        if(screen) {
            lvgl_go_track_screen(screen, UI_START_SCREEN);
            lv_screen_load(screen);
        }
    }
#endif
    lvgl_go_screens_update();
    emscripten_set_main_loop(frame, 0, 1);
    return 0;
}
