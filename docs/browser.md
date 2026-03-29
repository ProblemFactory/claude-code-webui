# Embedded Browser

Open an embedded browser window via the toolbar 🌐 button or command mode (`Ctrl+\` then `b`).

## Features

- **URL bar** with navigation (Enter to go, or click Go)
- **iframe-based** — loads web pages inside the WebUI window
- **Resizable and draggable** like any other window
- **Layout persistence** — URL and window position saved across page refreshes

## Proxy Mode

Toggle the **Proxy** button in the browser toolbar to enable `node-unblocker` proxy mode.

### Without proxy (direct iframe)
- Works for sites that allow iframe embedding
- Fastest, no URL rewriting
- Fails for sites with `X-Frame-Options` or `Content-Security-Policy` headers

### With proxy (`/proxy/<url>`)
The server rewrites all URLs in the HTML/CSS/JS response:
- HTML `src`, `href`, `action` attributes → rewritten to go through proxy
- CSS `url()` references → rewritten
- JavaScript XHR/fetch/WebSocket URLs → rewritten
- `X-Frame-Options` and `CSP` headers → stripped

This works for:
- noVNC and other internal web services
- Documentation sites
- Simple web applications

### Limitations

Sites with aggressive anti-bot detection (Google, Cloudflare) may trigger reCAPTCHA or block access. This is a fundamental limitation of all web proxies. For those sites, use **"Open in new tab ↗"** in the browser toolbar.

## Use Cases

- **noVNC**: View a remote desktop inside the WebUI
- **Documentation**: Reference API docs alongside your terminal
- **Internal services**: Monitor dashboards, check logs
- **Local dev servers**: Preview your app while coding
