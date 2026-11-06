#include <stdio.h>
#include <stdlib.h>

/* Assertion callback expected by the precompiled LVGL archive. */
void lvrt_assert_handler_cb(void)
{
    fputs("LVGL assertion failed. See the preceding LVGL log message.\n", stderr);
    fflush(NULL);
    abort();
}
