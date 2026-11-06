# Share a standalone preview

After a successful build, click **Export HTML** in the LVGL Go dashboard's **Share** section, then choose where to save the file. The command is also available as **LVGL Go: Export HTML Preview** in the command palette.

Send that single `.html` file to someone else. They can open it in a current Chrome, Edge, Firefox or Safari browser without installing LVGL Go or keeping your computer running. It can also be placed on a static web host. On mobile, open the file in a browser; a messaging or Files app's document preview may not run JavaScript or WASM.

The page includes LVGL Go branding, Auto/Fit sizing, the screen selector, display targets, hardware-frame visibility, touch button overlays, physical-keyboard input, the resizable runtime console and the memory monitor. All compiled assets and frame images are embedded and compressed. Larger projects produce larger HTML files.

The export uses the latest successful build and its configured starting screen. Selections or application state on another device are not captured. You can export that successful snapshot even if a subsequent build fails. The file stays at the exported revision; pairing, QR scanning, installation prompts and live reload are omitted.
