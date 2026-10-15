# x70 Scratch pipeline

A native pipeline for building high-performance [TurboWarp](https://turbowarp.org/) /
Scratch projects, meant to run in **GitHub Codespaces** (a real Linux container) and be used
from a browser — including a Chromebook. It gives Scratch projects the things a browser tab
can't do on its own, through one small local daemon:

- **Files** — read/write save files and data, sandboxed to set folders.
- **Commands** — run a short allow-list of local commands.
- **System metrics** — live CPU %, memory, load, uptime.
- **Fast cache** — a local Redis (with an automatic in-memory fallback if Redis isn't running).
- **Database** — SQLite via Node's built-in `node:sqlite`, for leaderboards and large data sets.
- **Live assets** — load uncompressed images/audio straight into the renderer and Web Audio at
  runtime, bypassing Scratch's asset-packing limits.
- **Events** — push messages into a running project from Node-RED, a script, or `curl`.
- **One-click packaging** — turn a saved `.sb3` into a standalone `.html` you open in the browser,
  with all the performance settings and the bridge connection baked in.

It has **no npm dependencies beyond the packager and JSZip**, and the bridge itself is plain Node.

> ### What Codespaces can and can't do
> Codespaces is a cloud Linux box you reach through the browser, so the bridge, Redis and SQLite
> all run there for real. What it **can't** do is show a native desktop window, so the thing you
> actually *run* is the packaged **`.html`** (or the TurboWarp web editor) in your browser. The
> `electron-*` build targets produce a desktop app as a downloadable `.zip` to run on a real
> Windows/Mac/Linux PC — they can't run inside Codespaces or on a Chromebook.

## Performance settings

`pipeline.config.json` → `runtime` controls the engine. The defaults already unlock everything:

| Setting | Default here | Effect |
| --- | --- | --- |
| `framerate` | `0` | **Match the monitor's refresh rate** (60/144/240 Hz…). `30` is stock Scratch. |
| `interpolation` | `true` | Smooths motion between frames. |
| `maxClones` | `"Infinity"` | No clone limit. |
| `fencing` | `false` | Sprites can move freely off-screen. |
| `miscLimits` | `false` | Removes assorted engine limits. |
| `highQualityPen` | `true` | Pen renders at full display resolution. |
| `warpTimer` | `false` | No warp-timer loop throttling. |
| `turbo` | `false` | Turbo mode (run scripts without yielding). |

These are applied two ways: baked into each packaged build, and (with `stampProjects`) written into
the `.sb3` itself as TurboWarp's own `_twconfig_` comment, so opening the project in the editor
shows the same unlocked settings.

## Quick start (Codespaces)

1. **Create a Codespace on this repo** and pick the **"x70 Scratch pipeline"** dev container
   (`.devcontainer/scratch`). It installs dependencies and starts the bridge automatically; port
   **7070** is forwarded. Nothing to type.
2. In the **Ports** tab, set port **7070** visibility to **Public** and copy its URL
   (`https://<codespace>-7070.app.github.dev`). Note the bridge **token** printed in the terminal
   (also in `scratch/data/bridge.token`).
3. Open **https://turbowarp.org/editor**, go to the extensions menu → **Custom Extension** →
   enter `<Public URL>/extension.js`, and make sure **"Run without sandbox"** is on.
4. In your project, use the **`pair with bridge`** block once with the Public URL and token. After
   that the x70 Bridge blocks work: files, cache, SQL, system metrics, live assets, events.
5. Save the project into `scratch/projects/` (TurboWarp: *File → Save to your computer*) and run
   **`npm run build`** (or **`npm run watch`** for automatic rebuilds). The result is
   `scratch/dist/<name>.html` — a single file, bridge connection baked in, that you open in the
   browser and share.

Not in Codespaces? Run it on any Linux/macOS machine or WSL the same way: `npm install`,
`npm run setup`, `npm run bridge`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run setup` | Make folders, mint the bridge token, write a starter project, print connection info. |
| `npm run bridge` | Start the bridge daemon (port 7070). |
| `npm run build` | Package every project in `projects/` into `dist/` (add a filename to build one). |
| `npm run watch` | Rebuild a project a moment after it's saved. |
| `npm run twconfig -- projects/game.sb3` | Stamp the performance settings into an existing `.sb3`. |
| `npm test` | Run the test suite. |

## How the pieces fit

```
TurboWarp project (browser)
   │  x70bridge.js extension  (unsandboxed; WebSocket + fetch)
   ▼
bridge daemon  (scratch/bridge/server.js, 127.0.0.1:7070, token-authenticated)
   ├── files ....... sandboxed to bridge.fsRoots (data/, assets/)
   ├── exec ........ only commands listed in bridge.exec.commands
   ├── cache ....... Redis  → in-memory fallback
   ├── sql ......... SQLite (node:sqlite, WAL)
   ├── assets ...... raw files served for live injection
   └── events ...... broadcast to every connected project (also POST /event)
```

`tools/build.js` reads the same config, sets the packager's options, and bakes a pre-paired copy
of the extension into each build so packaged games "just work".

## Security model

The bridge is a local service that can touch your files and run commands, so it is deliberately
fenced in:

- **Loopback + token.** It binds `127.0.0.1` and every call needs the random token in
  `data/bridge.token`. The token is never embedded in the extension source served at
  `/extension.js`; it only enters a build you make yourself, or the editor via the `pair` block.
- **Host + origin checks.** Requests with a foreign `Host` header are refused (DNS-rebinding
  guard), and WebSocket/CORS origins must be in `bridge.allowedOrigins`.
- **Filesystem sandbox.** Paths are resolved inside `bridge.fsRoots` only; `..`, absolute paths and
  symlinks that escape a root are rejected.
- **Command allow-list.** `exec.run` only runs commands defined in `bridge.exec.commands` — there
  is no "run anything" mode. User arguments are passed as argv, never through a shell.
- **Size and time limits.** File size, command output and command runtime are all capped.

When you forward port 7070 **Public** in Codespaces so the browser can reach it, the token is what
keeps it private — treat `data/bridge.token` like a password, and set the port back to Private when
you're done. If you only use the TurboWarp desktop app or a local browser, keep the port Private.

## Configuration

Everything lives in `pipeline.config.json`. Highlights:

- `bridge.fsRoots` — the folders projects may read/write (`data`, `assets` by default).
- `bridge.exec.commands` — the named commands projects may run (each is `{cmd, args}`; set
  `extraArgs: true` to allow appended arguments).
- `bridge.allowedHostSuffixes` — host suffixes allowed in addition to loopback, so the bridge works
  behind a forwarded port. The Codespaces forwarding domain (`app.github.dev`) is detected
  automatically from the environment; add other tunnel domains here (matched on a dotted boundary,
  so `app.github.dev` admits `x-7070.app.github.dev` but not `evilapp.github.dev`).
- `redis.url` / `redis.required` — point at a Redis instance; `required: false` falls back to memory.
- `build.targets` — e.g. `["html", "electron-linux64", "electron-win64"]`. `html` is the one you run
  in the browser; the `electron-*` targets are desktop `.zip` artifacts to download.

Override at runtime with env vars: `X70_BRIDGE_PORT`, `X70_REDIS_URL`, `X70_CONFIG`,
`X70_BRIDGE_PUBLIC_URL` (the URL baked into builds).
