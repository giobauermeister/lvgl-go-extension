#include <emscripten.h>
#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include "lvgl.h"
#include "memory.h"

/* Keep bookkeeping outside the measured allocator. No allocation headers or
 * sizes are changed. A saturated table makes the result explicitly incomplete. */
#ifndef LVGL_GO_MEMORY_SLOTS
#define LVGL_GO_MEMORY_SLOTS 32768u
#endif
typedef struct { void * pointer; size_t bytes; } allocation_t;
static allocation_t allocations[LVGL_GO_MEMORY_SLOTS];
static size_t used, peak, baseline, blocks, failures;
static int complete = 1;
#define DELETED ((void *)(uintptr_t)1)

void * __real_lv_malloc_core(size_t size);
void * __real_lv_realloc_core(void * pointer, size_t size);
void __real_lv_free_core(void * pointer);

static allocation_t * find(void * pointer, int insert)
{
    size_t hash = ((uintptr_t)pointer >> 3) * (uintptr_t)2654435761u;
    allocation_t * vacant = NULL;
    for(size_t i = 0; i < LVGL_GO_MEMORY_SLOTS; i++) {
        allocation_t * entry = &allocations[(hash + i) % LVGL_GO_MEMORY_SLOTS];
        if(entry->pointer == pointer) return entry;
        if(!entry->pointer) return insert ? (vacant ? vacant : entry) : NULL;
        if(entry->pointer == DELETED && !vacant) vacant = entry;
    }
    return insert ? vacant : NULL;
}

static void record(void * pointer, size_t size)
{
    if(!pointer) return;
    allocation_t * entry = find(pointer, 1);
    if(!entry) { complete = 0; return; }
    if(entry->pointer == pointer) used -= entry->bytes;
    else blocks++;
    entry->pointer = pointer; entry->bytes = size;
    used += size;
    if(used > peak) peak = used;
}

static void forget(void * pointer)
{
    if(!pointer) return;
    allocation_t * entry = find(pointer, 0);
    if(!entry) { complete = 0; return; }
    used -= entry->bytes; blocks--;
    entry->pointer = DELETED; entry->bytes = 0;
}

void * __wrap_lv_malloc_core(size_t size)
{
    void * pointer = __real_lv_malloc_core(size);
    if(pointer) record(pointer, size);
    else if(size) failures++;
    return pointer;
}

void __wrap_lv_free_core(void * pointer)
{
    forget(pointer);
    __real_lv_free_core(pointer);
}

void * __wrap_lv_realloc_core(void * pointer, size_t size)
{
    allocation_t * old = pointer ? find(pointer, 0) : NULL;
    int unknown = pointer && !old;
    void * next = __real_lv_realloc_core(pointer, size);
    /* The supported C/TLSF backends release p for a zero-size request. Public
     * lv_realloc handles that case through lv_free before reaching this hook. */
    if(!next && size) { failures++; return NULL; }
    if(unknown) complete = 0;
    if(old) {
        used -= old->bytes; blocks--;
        old->pointer = DELETED; old->bytes = 0;
    }
    record(next, size);
    return next;
}

void lvgl_go_memory_baseline(void) { baseline = used; peak = used; }

EMSCRIPTEN_KEEPALIVE const char * lvgl_go_memory_snapshot(void)
{
    static char json[1024];
    char pool[256] = "null";
#if LV_USE_STDLIB_MALLOC == LV_STDLIB_BUILTIN
    lv_mem_monitor_t monitor;
    lv_mem_monitor(&monitor);
    snprintf(pool, sizeof(pool),
        "{\"total\":%zu,\"used\":%zu,\"free\":%zu,\"largest\":%zu,\"peak\":%zu,\"fragmentation\":%u}",
        monitor.total_size, monitor.total_size - monitor.free_size, monitor.free_size,
        monitor.free_biggest_size, monitor.max_used, (unsigned)monitor.frag_pct);
#endif
    snprintf(json, sizeof(json),
        "{\"used\":%zu,\"peak\":%zu,\"baseline\":%zu,\"blocks\":%zu,"
        "\"failures\":%zu,\"complete\":%s,\"pointerBits\":%zu,\"colorDepth\":%d,"
        "\"bookkeeping\":%zu,\"pool\":%s}",
        used, peak, baseline, blocks, failures, complete ? "true" : "false",
        sizeof(void *) * 8, LV_COLOR_DEPTH, sizeof(allocations), pool);
    return json;
}
