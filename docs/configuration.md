# Project configuration

LVGL Go works with its default settings. Add `lvgl-go.json` to the project folder when you need custom assets or build requirements. Changes apply when you restart the session. LVGL Pro maintains the C export; LVGL Go compiles it for the browser.

## Runtime options (optional)

For example, to preload file assets (images, fonts, media or data intended for the device):

```json
{
  "runtime": {
    "assetsDir": "assets",
    "assetPath": "A:/assets"
  }
}
```

| Option | Meaning |
| --- | --- |
| `lvglLibraryDir` | LVGL Pro’s versioned `libs` directory; detected automatically from `lvgl_version` in `project.xml`. The library version must match the project. |
| `lvglSourceDir` | Matching local LVGL checkout for a source build. |
| `defaults` | LVGL configuration defaults for a source build; requires `lvglSourceDir`. |
| `initialScreen` | Permanent screen variable to select if custom initialization leaves the default screen active. |
| `startScreen` | Exported constructor such as `screen_menu_photo_items_create`, called if initialization does not load a screen. |
| `width`, `height` | Logical display size overrides. |
| `assetsDir` | Dedicated public asset folder preloaded at `/assets`; source/configuration files and symlinks are rejected. |
| `assetPath` | Path passed to UI initialization. |

Paths are relative to the project folder and can use `${workspaceFolder}` or `${extensionDir}`. Embedded C image and font assets are included through the project’s source lists.

For projects with several screens created on demand, **Start Session** asks which screen to open and remembers the choice for that project. Use **Choose Starting Screen** in the dashboard to change it and rebuild. A single exported screen is selected automatically. `runtime.startScreen` sets an explicit project configuration.

When the compiled UI has multiple screens, the PWA also shows a **Screen** dropdown at the upper right of the preview, below the toolbar. It switches screens immediately in the running UI without rebuilding or downloading again. The next build still starts from the configured starting screen.

Hardware frames and display targets come directly from `project.xml`; no `lvgl-go.json` options are needed. See [Hardware frames](hardware-frames.md).

Turn on **View → Console** to show `LV_LOG_USER` output, stdout/stderr, and WASM/SDL diagnostics, including reported assertion failures. It starts hidden and retains startup logs. No log-level setting is needed.

Turn on **View → Memory** for live allocation measurements and an optional reference budget. Source builds with LVGL's built-in allocator also expose pool statistics. See [Memory monitor](memory.md) for firmware comparisons.

For a custom LVGL source build:

```json
{
  "runtime": {
    "lvglSourceDir": "/path/to/lvgl",
    "defaults": "browser-lv-conf.defaults"
  }
}
```

## Custom build commands (advanced)

To use your own browser build, set `build` to an array of commands and `outputDir` to the resulting bundle directory. Each command has a `command`, an `args` array, and optional `cwd` and `env` properties.

For example, to use a project's existing browser target:

```json
{
  "outputDir": "${buildDir}/bin",
  "build": [
    {
      "command": "emcmake",
      "args": ["cmake", "-S", "${projectDir}/sim", "-B", "${buildDir}"]
    },
    {
      "command": "cmake",
      "args": ["--build", "${buildDir}", "--parallel", "4"]
    }
  ]
}
```

Commands execute in order, with one build at a time. The watcher waits for a 900 ms quiet period by default; `debounceMs` changes that interval and `watch: false` disables automatic builds.

Command placeholders include `${workspaceFolder}`, `${projectDir}`, `${buildDir}`, `${extensionDir}` and `${env:NAME}`. Commands run without a shell and require a trusted workspace.

The extension manages its preview port and, in Internet mode, its HTTPS tunnel automatically. Check **Local network (HTTP)** in the dashboard for a direct LAN preview; no project configuration is needed. For an advanced self-hosted Internet-mode deployment, see [PWA hosting](hosting.md).

Managed builds read `lvgl_version` on every build and use the matching installed LVGL Pro WebAssembly library. Both the older `include/lvgl/lv_conf.h` layout and the LVGL 9.6 `include/lvgl/config/lv_conf.h` layout are supported. Projects without `lvgl_version` retain the legacy 9.5.0 default; set the attribute in LVGL Pro when migrating them.
