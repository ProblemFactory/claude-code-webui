# Plugins

VibeSpace plugins are folders under `data/plugins/<id>/` with a `vibespace-plugin.json` manifest. A plugin can add **windows** (sandboxed UI), **agent tools** (CLIs every session can call), **settings**, **themes**, and run its **own server process**. Install, enable, update and uninstall them from ⚙ → **Plugins**.

The smallest complete plugin is `docs/examples/hello-plugin` (one iframe window, one proxied route, one agent tool, one setting, one theme).

## Built-in plugins (⚙ → Plugins, top of the panel)

Three capabilities ship with VibeSpace itself and appear above the installed
plugins. They are not manifest packages — they are host features with the same
enable / start / stop / status shape, stored in `data/plugins.json`.

| Plugin | What it does | Default |
|---|---|---|
| **Tailscale** | Join your tailnet so this instance can reach home/LAN machines. The node key lives in the plugin's state dir, so a container rebuild reconnects without re-login. | off |
| **Public URLs (frp)** | Publish a forwarded port through the shared frp relay as a shareable link. Needs the relay configured (env or the fields in the card). | off (auto-on where the relay is injected) |
| **OpenCode background service** | Runs `opencode serve` on 127.0.0.1 so **stopped** OpenCode conversations can be listed, opened, resumed and forked. OpenCode keeps its conversations in its own database rather than in files, so without it only *running* OpenCode sessions appear. | **off** |

### OpenCode background service

There is nothing to install (it runs *your* `opencode` CLI — VibeSpace never
downloads one) and nothing to configure (it binds a free loopback port). The
switch is deliberate:

- The **first** time you use OpenCode here — creating an OpenCode session, or
  opening/forking an OpenCode conversation — VibeSpace shows one dialog:
  **Enable & start** or **Not now**. The answer is remembered for the whole
  instance, so you are asked once no matter how many tabs or devices you use.
- Enabling continues whatever you were doing: the serve starts and the pending
  open/fork re-runs once it answers.
- While it is off, the session list carries a row saying *"Stopped OpenCode
  conversations are hidden — its background service is off"* with an Enable
  action. ⚙ → Plugins is the other way back.
- Disabling it **stops the process** — including one left running by a previous
  VibeSpace — and nothing restarts it.
- VibeSpace samples the serve's CPU and memory and stops it (visibly, with the
  numbers) if it runs away; it will not restart it for an hour.
- `VIBESPACE_OPENCODE_SERVE=1` / `=0` is an ops override that wins over the
  switch; the card then says it is forced by the environment and disables the
  controls. `=0` also stops a serve this instance inherited from a previous
  (SIGKILLed) server instead of adopting it — a locked card never describes a
  daemon that is still running. On such an instance the session-list row still
  explains the hidden history, without an Enable button.
- A service that is simply OFF is never reported as an error. Only a service
  that BROKE — parked after repeated crashes, or stopped by the runaway guard —
  raises the red "OpenCode: …" toast.

## Manifest (`vibespace-plugin.json`)

```jsonc
{
  "id": "acme.tool",                 // <publisher>.<name>, lowercase; must equal the folder name
  "version": "1.2.3",
  "engines": { "vibespace": "2.369.24" },   // minimum host version
  "label": "Tool",                   // optional display name (default: the <name> part)
  "description": "…",
  "icon": "<svg …>",                 // optional inline SVG ≤ 4 KiB, no scripts/handlers

  "client": "none" | "iframe" | "module",
  "clientEntry": "client.js",        // module tier only: relative .js path inside the plugin dir
  "server": true,                    // server.js runs as its own process (see Server process)

  "contributes": {
    "windows":    [{ "id": "main", "title": "Main", "entry": "index.html" }],   // iframe tier; files under ui/
    "agentTools": [{ "name": "hello", "description": "…", "args": { "type": "object", "properties": { … } } }],
    "routes": true,                  // /api/plugins/<id>/x/* is proxied to the server process
    "settings":   [{ "key": "greeting", "type": "string", "default": "hello", "label": "Greeting", "description": "…" }],
    "themes":     [{ "id": "mint", "label": "Mint", "file": "themes/mint.json" }]
  },

  "capabilities": {                  // declared at install, shown at enable, ENFORCED server-side
    "server": {
      "fs": { "read": ["~/data", "/srv/x"], "write": ["~/data"] },
      "childProcess": true,
      "net": ["api.example.com"]     // declared only (see Enforcement)
    }
  }
}
```

Validation is one function (`src/plugin-manifest.js`) shared by the server, the client and the tests. Errors are listed in the Plugins panel; an invalid plugin cannot be enabled.

### Settings
`contributes.settings[]` — `type` is `boolean` | `string` | `number` (`min`/`max`/`step`) | `select` (`options`: strings or `{ value, label }`; `default` must be one of them). They appear in the Settings window under **Plugin: <label>** as `plugin.<id>.<key>`, persist and sync like every setting, and disappear when the plugin is disabled (stored values are kept).

### Themes
`contributes.themes[]` — `file` is a JSON file inside the plugin dir:

```json
{ "css": { "--accent": "#2fbf9f", "--bg": "#0f1a17" }, "terminal": { "background": "#0f1a17", "foreground": "#d8f3e8" } }
```

Only `--custom-property` keys with short values (no `{ } ;`) are accepted — themes reach every client. Registered themes are selectable as **<label> (plugin)** while the plugin is enabled.

## Client tiers

| `client` | What runs in the browser | Trust |
|---|---|---|
| `none` | nothing | — |
| `iframe` | each `contributes.windows[]` entry in a **sandboxed iframe** (opaque origin, `allow-scripts allow-forms allow-modals allow-popups allow-downloads`, never `allow-same-origin`). It talks to VibeSpace only through the postMessage bridge (`ready` / `init` / `storage` / `notify` / `close`) and to its own server process through `/api/plugins/<id>/x/…`. | no consent needed |
| `module` | `clientEntry` is **imported same-origin** as an ES module and `activate(api)` is called. It has the same access as VibeSpace itself. | **owner consent required** ("Enable (trusted)") |

### Trusted module API (`activate(api)`)
`api.id`, `api.version`, `api.manifest`, `api.signal` (aborts on deactivate), `api.app` (the App mediator — it IS trusted code),
`api.registerWindowType({ id, label, icon?, render(winInfo) })` → window type `plugin:<id>:<wid>`, `api.openWindow(wid)`,
`api.showToast(text, { type })`, `api.createModalShell(opts)`, `api.t(str, params)`,
`api.fetch(path, opts)` (only `/api/plugins/<id>/x/*`),
`api.settings.get/set/path(key)` + `api.settings.onChange((key, value) => …)`,
`api.storage.get/set/del(k)` (localStorage, namespaced with its iframes),
`api.on('theme-changed' | 'plugins-manifests-updated' | 'ws', fn)` → unsubscribe.
Export `deactivate()` to clean up; the host also aborts `api.signal`. A module that throws at import/activate is reported in the Plugins panel and never breaks VibeSpace's boot.

**Commands, menu items, keybindings (Ph1 registries — `src/lib/contributions.js`).** VibeSpace's own context menus, ⚙ gear menu and command-mode actions are registrations in the same registries, so a plugin contributes exactly the way core does:
- `api.registerCommand({ id: 'my-verb', title, run(ctx), when?(ctx), icon? })` → the command id is namespaced `plugin:<pluginId>:my-verb`. `title` is a string or `(ctx) => string`; `when` hides the command from every menu and makes its keybindings inert (it is not consulted by `runCommand`).
- `api.registerMenuItem({ menu, command | label + run(ctx), group?, order?, when?(ctx), disabled?, style?, tooltip?, icon?, children?, separator? })` — `menu` is `'session-card'` (sidebar card right-click; `ctx = { app, state, s, card, event, … }` — `ctx.s` is the session), `'window'` (window title-bar / taskbar / window-list right-click; `ctx = { app, id, win, s (session or null), … }`) or `'gear'` (the ⚙ menu; `ctx = { app, pop }`). `command` is your own slug or any full command id (e.g. `'session.properties'`). Items sort by `group` (`'navigation'` first, then alphabetically — core uses `0_primary`, `1_state`, `2_locate`, `3_admin` on the card and `1_window`, `2_session`, `3_close` on the window menu), then `order`, then registration. Separators are explicit items (`{ separator: true, group, order }`); leading / trailing / doubled ones collapse. `when` + `children` may be functions of `ctx`; an empty `children` result hides the item.
- `api.registerKeybinding({ key: 'ctrl+shift+k', command, when?(ctx) })` — chords are `ctrl` / `alt` / `shift` / `meta` (+ `mod` = ctrl **or** meta) plus one key (`k`, `f5`, `escape`, `arrowleft`, `+`…); matching is exact (unlisted modifiers must be up); later registrations win; keys typed inside a terminal never match unless `inTerminal: true`; the dispatcher runs in the bubble phase and leaves already-handled keys alone. `ctx` is `{ app, event }`.
- `api.runCommand(id, ctx)` runs any registered command (own slug or full id); an unknown id throws.
Every registration returns a `dispose()` and is also bound to `api.signal`, so a plugin's commands, rows and keys are removed when it is disabled, uninstalled or reloaded. Labels are shown as given — wrap them in `api.t()` yourself; never put HTML in a `label` (use `labelHtml` only with escaped strings).

## Consent
Enabling a `module` plugin, a plugin that declares `capabilities`, or a plugin that contributes **agent tools** opens a dialog listing what it asks for in plain words (the same list the server computes). Agent tools count because each one becomes a program on every session's PATH — on this machine, on every ssh host and on every paired device — running *outside* the plugin's `node --permission` sandbox. **Enable (trusted)** records `{ trusted, trustedAt, capabilitiesHash }` in `data/plugin-registry.json`. If a later version changes its consent-relevant surface (tier, capabilities, agent tools, routes), the plugin is switched **off** on discovery with a notice and must be reviewed again. ⋯ → **Show capabilities…** shows the current list any time.

**Consent covers a package, not a name.** Installing under a plugin id that still holds consent only keeps its enabled/trusted state when the package is byte-identical (its content fingerprint) *and* comes from the same recorded source; anything else is new code, so the plugin is left disabled with a notice and must be reviewed again. This holds even when nothing was overwritten — consent lives in the registry, so deleting a plugin's folder by hand does not clear it, and the next package installed under that id still has to be reviewed. **Update** (⋯ → Update, which re-runs the source you already chose) keeps consent.

## Server process
With `"server": true`, `server.js` is forked as its own Node process and talks to the host over IPC only (`route` / `tool` / `shutdown` messages, api version 1 — see the example). A proxied reply (`/api/plugins/<id>/x/…`) is **data on the VibeSpace origin**: it always ships with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox; default-src 'none'`, and a document content-type (`text/html`, `image/svg+xml`, …) from a plugin that is not trusted is served as `text/plain`. Serve UI from `ui/` (iframe tier), never from a route. Environment: `VIBESPACE_PLUGIN_ID`, `VIBESPACE_PLUGIN_DIR`, `VIBESPACE_PLUGIN_DATA` (a writable per-plugin state dir), `VIBESPACE_PLUGIN_API_VERSION`. Crash loops back off and park after 5 crashes in 10 minutes.

### Enforcement (`node --permission`)
The process runs under Node's permission model with an allowlist of: the plugin dir (read), its data dir (read/write) and whatever `capabilities.server.fs` declares (`~` expands; a declared **write** path also grants read; paths are normalized — and matched — the way node's permission model does, so a declared path may never cover VibeSpace's install or data dir; anything that would is refused at install). Two rules follow from how node reads a path: `//`, `/./` and a trailing `/.` collapse; and a `*` **truncates** the pattern — node grants every path whose text starts with what came before the `*`. So a pattern carries at most one `*`, as its last character (`~/projects/*` = that subtree; `~/projects/log*` = anything starting with that text — a `*` in the middle is refused, because node would ignore everything after it and grant far more than the pattern reads), and `/*`, `~/*` or any wildcard sitting over VibeSpace's own dirs is refused. Child processes need `capabilities.server.childProcess: true`. An access outside the allowlist fails inside the plugin with `ERR_ACCESS_DENIED`; the loader shows it as the plugin's error. **Network is not restricted by the permission model** — `capabilities.server.net` is declared and shown, not enforced.

## Agent tools
Each `contributes.agentTools[]` becomes an executable `data/bin/vibespace-tool-<id>-<name>` (generated — `name`/`description`/`args` are embedded as JSON constants, never as code) on every session's PATH (local, ssh hosts and paired devices — it ships with the core `vibespace-*` tools). It posts `{ args }` to `/api/agent/plugin-tool/<id>/<name>` with the session's own token; the plugin receives `{ name, args, session: { sessionId } }` and never sees a credential. On a remote host the shim calls back through the session's `VIBESPACE_API` channel, or the instance's public URL (Ports panel / `agentd.publicUrl`) baked in when the shim was generated; with neither it fails with a clear message.

## Install, update, uninstall
⚙ → Plugins → **Install plugin…**

| Source | Value |
|---|---|
| Local folder | a directory holding `vibespace-plugin.json` |
| Git | `https://host/owner/repo(.git)[#branch]` or `git@host:owner/repo.git` (shallow clone, 60 s) |
| `.vsp` package | a zip of the plugin folder (a single top-level folder is unwrapped) |
| GitHub release | `owner/repo[@tag]` — the release's `*.vsp` asset (public repos) |

Packages are staged, validated (manifest, host version, capability paths, no symlinks, size caps, Zip-Slip), then moved into `data/plugins/<id>/`. A previous copy of the same id is moved to `data/plugins-trash/<id>-<time>/` — nothing is ever deleted. **Update** re-runs the recorded source (zip installs: upload the new file). **Uninstall** moves the plugin folder and its state dir to the trash.

## Where things live
`data/plugins/<id>/` (the plugin), `data/plugins-state/<id>/` (its data), `data/plugins-trash/` (previous copies), `data/plugin-registry.json` (enabled / trust / install records), `data/bin/vibespace-tool-*` (generated shims).
