# PWA hosting

LVGL Go uses `https://go.bauertronix.com.br/app/` by default. Extension users do not need a hosting account, domain or deployment configuration.

The PWA serves the mobile launcher, QR scanner and icons. In Internet mode, preview builds come from the active extension session through its automatic HTTPS tunnel. Hosting the launcher yourself does not change that connection.

## Local network preview

Check **Local network (HTTP)** in the extension dashboard before **Start Session**. Internet mode is the initial default, and the checkbox remembers your choice. Stop the session before switching modes.

The extension serves both the app and WASM preview directly from a private IPv4 address on your computer. Scan the QR code with your phone's camera or open the pairing link in a browser on the same network. If several LAN adapters are available, choose the network shared with your device. No tunnel or separate PWA deployment is used for that session; `appUrl` applies only to Internet mode.

Live reload, screen/display selection, hardware frames, console and memory monitoring work locally. HTTP does not provide the secure context required for app installation, service workers or the browser camera scanner. Use the local URL directly rather than scanning it inside the hosted HTTPS app.

Keep the computer running. Its firewall must allow the preview connection, and guest Wi-Fi/client isolation must not block traffic between the devices. Switching networks or changing the computer's address may require restarting the session. Emscripten and matching LVGL resources must already be installed to build without internet access.

## Self-hosting (advanced)

The launcher is a static site. You can serve it with your own web server or a static hosting provider.

1. Run `npm run package:pwa`.
2. Deploy the contents of `artifacts/lvgl-go-pwa.zip`, or the `artifacts/pwa/` folder, to your site's root. Keep the `app/` directory intact.
3. Serve the app at `https://your-host.example/app/` with a certificate trusted by your device.
4. Set `appUrl` in the project's `lvgl-go.json`, then restart the session:

```json
{
  "appUrl": "https://your-host.example/app/"
}
```

`appUrl` selects an existing launcher deployment. It does not start a web server or host the PWA. The address must use HTTPS, have exactly the `/app/` path and contain no query, fragment or credentials. Omit it to use the default app.

You can host the PWA on your own computer or private network if the phone can reach that HTTPS address and trusts its certificate. A phone's `localhost` refers to the phone itself. A custom `appUrl` still uses Internet mode's tunnel for previews. For direct LAN access, use the dashboard's **Local network (HTTP)** checkbox instead.

## Web server requirements

Serve the files under `/app/` with their correct content types, including JavaScript and the web manifest. Revalidate launcher assets on update and serve `/app/sw.js` without a stale cache. The service worker is scoped to `/app/`.

The package includes `_headers` and `_redirects` for hosts that support that format. On other servers, translate those files into the server's configuration. In particular, allow HTTPS connections and HTTPS preview frames in the Content Security Policy, and camera access for the QR scanner. Redirecting `/` to `/app/` is optional; the extension always links directly to `/app/`.

The installed PWA keeps its identity at the same origin and `/app/` scope. Its service worker updates the launcher assets when the app reconnects. Changing the hostname creates a separate app installation.

For a custom domain, configure DNS and HTTPS with your chosen hosting provider.

## Netlify example

Download `lvgl-go-pwa.zip` from a GitHub Release or a successful **Build packages** run, or run `npm run package:pwa` locally. Upload the ZIP or the contents of `artifacts/pwa/` as a Netlify site. The included `_headers` and `_redirects` files supply its headers and routing rules.

Set `appUrl` to the site's HTTPS address followed by `/app/`, for example `https://your-site.netlify.app/app/`. For a custom domain, add it to the Netlify site and configure the DNS records Netlify provides.

## Connection and storage

The LED beside **Connected** lights when the desktop session responds and turns off when disconnected. Build progress is tracked separately, so a build failure does not turn off an active connection.

The PWA stores launcher assets for offline startup and remembers the last session for reconnecting. Preview bundles are served by the active desktop session. Keep that computer running while previewing. Stopping the session revokes its pairing link.
