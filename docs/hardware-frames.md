# Hardware frames

Managed previews read display targets and hardware overlays from `project.xml`. The PWA shows **View → Hardware frame** when the current target provides an overlay, and **Display** at the top right when the project provides multiple targets.

The image's natural pixel dimensions define the device coordinate system. The display's `width` and `height` define the WASM framebuffer. `viewport_x` and `viewport_y` position that framebuffer within the frame image. Button `x`, `y`, `w` and `h` use the same image coordinates.

The display's optional `radius` rounds the preview's corners in framebuffer pixels. For example, `<display width="410" height="502" radius="120" />` uses 120-pixel corners. The radius scales with Auto/Fit, follows the selected display, and applies with or without a hardware frame, including in exported HTML. Omitting it or setting it to `0` keeps square corners.

```xml
<display width="368" height="448">
    <overlay viewport_x="78" viewport_y="88"
             image_src_path="images/hardware.png" hidden="false">
        <button_overlay x="291" y="654" w="52" h="40"
                        key="arrow_down" name="DOWN"
                        help="Move down" color="0x2adef6" />
    </overlay>
</display>
```

A commented overlay declaration is supported as a fallback for Editor versions that do not yet accept these elements. An active overlay takes precedence over the commented version for that display.

Each target uses its own frame and buttons. Targets without an overlay remain available in the Display menu and show the UI alone. Selecting a display changes LVGL's logical resolution and fires `LV_EVENT_RESOLUTION_CHANGED`. Custom layout callbacks must be registered for simulation builds (`LV_SIM_BUILD`) to react to those changes. `LV_EDITOR_PREVIEW` remains specific to Editor preview.

Frame visibility starts from `hidden`. Your frame visibility and display selection are retained across live rebuilds within the session. Auto/Fit scale the image, viewport and touch regions together. Frame toggles and display selection preserve the running WASM instance. Physical keyboards continue to control the UI; preview controls use touch and do not open a virtual keyboard.

Tap outside the UI and hardware buttons to highlight the touch areas.

All configured frame images load at startup and count toward the download progress, so switching display targets does not need another download. A broken frame falls back to the UI alone.

Supported button keys include `arrow_up`, `arrow_down`, `arrow_left`, `arrow_right`, `enter`, `esc`, `backspace`, `delete`, `tab`, `page_up`, `page_down`, `home`, `end`, `space`, and single printable ASCII characters such as `m` and `p`. Each touch sends one simulated key press through the existing SDL keypad. `name` and `help` describe the button; `color` provides its pressed highlight.

Use a PNG frame image inside the project. Changes to the frame configuration and images trigger the normal live build.
