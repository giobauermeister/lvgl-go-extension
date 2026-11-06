#ifndef LVGL_GO_SCREENS_H
#define LVGL_GO_SCREENS_H

#include "lvgl.h"

/* Observe project-owned instances without taking over their lifecycle. */
void lvgl_go_observe_screen(lv_obj_t * screen, lv_obj_t * (*create)(void));
void lvgl_go_track_screen(lv_obj_t * screen, lv_obj_t * (*create)(void));
void lvgl_go_screens_update(void);

#endif
