# Memory monitor

Open the menu at the top right and turn on **Memory** to show the live chart. The popup starts hidden and is included in standalone HTML exports. On desktop, drag its heading to move it; touch devices keep a fixed position.

Green shows live usage, dashed blue shows the peak, and dashed yellow shows the optional reference budget.

- **Live requested** is the sum of live allocation sizes requested through LVGL's allocator.
- **Peak since UI init** records the highest total, including short-lived allocations between chart updates.
- **Change since UI init** compares current usage with the baseline taken immediately before project initialization.
- **Live allocations** counts allocations that have not been freed.

These totals cover all live screens, caches and allocations made through LVGL. The displayed screen name identifies the active screen; the totals are not an ownership report for that screen alone. Direct C `malloc` calls, static image/font data, stacks and browser/SDL resources allocated outside LVGL are excluded. The allocation tracker does not change requested sizes or add headers to measured allocations. Its own fixed bookkeeping storage is outside the measured LVGL allocations.

Enter an optional **Reference budget** in KiB to add a chart line. Both current usage and the recorded peak are checked. With the default C allocator, requested bytes exclude allocator overhead and fragmentation, so a value below the budget does not guarantee that the UI fits on firmware.

If a source build uses `LV_STDLIB_BUILTIN`, the popup also reports LVGL pool usage, free memory, the largest free block and fragmentation. Its chart and budget comparison then use the pool's statistics. The default precompiled library uses the C allocator and does not provide these pool statistics.

## Comparing with firmware

The managed preview is WASM32: pointers and `size_t` are 4 bytes. The popup reports the actual compiled pointer width and color depth. The default preview uses 32-bit color; this is independent of pointer width.

There is no 16/32-bit conversion switch. Pointer widths, structure alignment, allocator behavior, display buffers, image formats, fonts, caches and enabled LVGL features can change memory consumption. A multiplier cannot reproduce these differences.

For a closer comparison, build the same LVGL version from source with matching firmware settings using `runtime.lvglSourceDir` and `runtime.defaults`. Keep the browser's SDL driver settings required by the preview. A built-in heap configuration can specify, for example:

```text
LV_USE_STDLIB_MALLOC LV_STDLIB_BUILTIN
LV_MEM_SIZE          (256 * 1024U)
```

Use a complete browser defaults file, including these overrides, rather than replacing all browser settings with these two lines. Changing the reference budget in the popup does not resize or enforce the runtime heap.

Measurements are for the compiled preview. Confirm final RAM requirements on the target firmware, particularly allocation overhead, fragmentation, external RAM and display-buffer placement. Matching a 32-bit pointer width alone does not make the two builds identical.
