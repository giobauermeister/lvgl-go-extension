#include <stdint.h>
#include <SDL2/SDL.h>
#include "lvgl.h"
#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

/* Feed the same SDL keypad created before UI_INIT, including project-owned
 * LV_EVENT_KEY callbacks. LVGL's SDL driver emits both press and release. */
EMSCRIPTEN_KEEPALIVE int lvgl_go_send_key(uint32_t key)
{
    SDL_Event event = {0};
    SDL_Keycode code = 0;
    switch(key) {
        case LV_KEY_UP: code = SDLK_UP; break;
        case LV_KEY_DOWN: code = SDLK_DOWN; break;
        case LV_KEY_LEFT: code = SDLK_LEFT; break;
        case LV_KEY_RIGHT: code = SDLK_RIGHT; break;
        case LV_KEY_ENTER: code = SDLK_RETURN; break;
        case LV_KEY_ESC: code = SDLK_ESCAPE; break;
        case LV_KEY_BACKSPACE: code = SDLK_BACKSPACE; break;
        case LV_KEY_DEL: code = SDLK_DELETE; break;
        case LV_KEY_NEXT: code = SDLK_TAB; break;
        case LV_KEY_PREV: code = SDLK_PAGEUP; break;
        case LV_KEY_HOME: code = SDLK_HOME; break;
        case LV_KEY_END: code = SDLK_END; break;
        default:
            if(key < 32 || key > 126) return 0;
            event.type = SDL_TEXTINPUT;
            event.text.text[0] = (char)key;
            return SDL_PushEvent(&event) == 1;
    }
    event.type = SDL_KEYDOWN;
    event.key.state = SDL_PRESSED;
    event.key.keysym.sym = code;
    return SDL_PushEvent(&event) == 1;
}
