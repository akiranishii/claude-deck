# Claude Deck — Architecture

## Processes

```
┌──────────────────────── macOS ────────────────────────┐            ┌──────────── VM (Linux) ────────────┐
│ Renderer (React)  ──window.deck.invoke──▶ Preload      │            │                                    │
│   no Node, sandboxed, CSP                │             │  ssh -T    │  python3 -   (cdeck_helper.py,      │
│                                          ▼             │  (Control- │   streamed per call, argv-only)    │
│ Main process ── zod-validated IPC ──▶ Deck services ───┼──Master)──▶│    ├─ tmux list/new/respawn/kill    │
│   ├─ SQLite (node:sqlite)                              │            │    ├─ /proc (process tree, 2 env    │
│   ├─ SshClient (system ssh, ~/.ssh/config, IAP)        │            │    │   vars, TLS sockets)            │
│   ├─ Monitor (snapshot every 15 s)                     │            │    ├─ claude --version / auth status │
│   ├─ Chrome launcher (open -n -a … --profile-directory)│            │    └─ Claude metadata (whitelisted)  │
│   ├─ Terminal launcher (.command → ssh -t … tmux attach)│           │                                    │
│   └─ Extension bridge (127.0.0.1, optional)            │            │  tmux ─▶ env CLAUDE_CONFIG_DIR=… \  │
└────────────────────────────────────────────────────────┘            │            claude remote-control … │
                                                                      └────────────────────────────────────┘
```

The renderer can only call named operations (`src/shared/ipc.ts`). Each request is validated by a zod schema
(`src/main/ipcSchemas.ts`) and checked to come from the app’s own top frame before reaching a service.

## SSH transport (`src/main/ssh`)

- The system `/usr/bin/ssh` is used so `~/.ssh/config` is honoured exactly (my-vm uses a `gcloud compute start-iap-tunnel` ProxyCommand).
- A private ControlMaster (`/tmp/cdeck-<uid>/cm-%C`, mode 0700, ownership verified) keeps one authenticated tunnel open: a call costs one
  round trip instead of a ~3.5 s IAP handshake. `BatchMode=yes` prevents hidden password prompts; `ServerAliveInterval=15` detects dead tunnels.
- Apps launched from Finder have a minimal PATH, so the login-shell PATH is read once (`$SHELL -lc 'env -0'`, only PATH/CLOUDSDK_*/proxy/agent
  variables kept) and merged with common Homebrew/gcloud locations.
- The master is started without `-f`: with `ControlPersist` ssh backgrounds itself only once it owns the control socket, so it can never
  detach as an unshared connection that runs forever. A dead socket left by a killed master is removed (only inside the private directory).
- On quit, a tunnel that is still connecting is aborted and the master is asked to *stop* (`-O stop`): no ssh process outlives the app,
  open terminal windows stay attached, and nothing on the VM is touched. Errors caused by quitting are never recorded as outages.
- After sleep/wake the master is reset and polling resumes. Failures are classified (auth, host key, gcloud re-auth, unreachable/VM stopped).

## Remote helper protocol (`resources/remote/cdeck_helper.py`)

`ssh my-vm python3 -` receives the helper source followed by `entry("<base64 JSON>")`. The request never passes through a shell. The
helper prints one line `__CDECK_RESULT__{json}`. Operations: `probe`, `snapshot`, `list_dir`, `check_path`, `mkdir`, `git_info`, `containers`,
`auth_status`, `list_config_dirs`, `create_config_dir`, `launch_runtime`, `stop_runtime`, `end_session`, `restart_in_shell`, `capture`,
`login_start`, `login_poll`, `login_cleanup`. See [REMOTE_HELPER.md](REMOTE_HELPER.md).

`snapshot` (≈0.5 s on the VM) returns tmux sessions/panes, the Claude process tree (Remote Control servers and their conversation
children), each server’s config dir (from `/proc/<pid>/environ`, `CLAUDE_CONFIG_DIR` only), its ESTABLISHED TLS sockets, Claude’s
`sessions/<pid>.json` (→ `bridgeSessionId`) and `projects/*/bridge-pointer.json` (→ `environmentId`, matched by pid **and** start time),
a sanitized capture of the visible screen, and optionally git/container/path checks.

## Launching (account isolation)

```
tmux new-session -d -s cd-<project>-<account>-<hex> -c <folder> -x 220 -y 50 -- \
  <login-shell> -lic 'exec "$@"' claude-deck \
    env [-u CLAUDE_CONFIG_DIR | CLAUDE_CONFIG_DIR=/home/…/.claude-account3] CLAUDE_DECK_RUNTIME_ID=rt_… \
    /home/…/claude remote-control --name … --spawn … --permission-mode …
  ; set-option -w remain-on-exit on ; set-option @cdeck_runtime rt_… ; set-option @cdeck_managed 1
```

- tmux ≥ 3.0 executes multi-argument commands without a shell; the login-shell wrapper receives the real arguments as positional
  parameters, so nothing is re-parsed. It loads the user’s interactive environment (PATH for nvm/npm-global, like a manual session).
- `CLAUDE_CONFIG_DIR` exists only in that process’s environment (the default account explicitly unsets an inherited value).
- `remain-on-exit` keeps the pane after Claude exits so the exit status and output are visible, and Restart can `respawn-pane`.
- The `@cdeck_runtime` session option and `CLAUDE_DECK_RUNTIME_ID` let Claude Deck recognise its sessions even after a rename or a reinstall.
- Flags are checked against the CLI’s `--help` (spawn/permission modes); unsupported requested flags are errors, not silently dropped.
  Claude rejects `--continue` together with `--spawn/--capacity/--create-session-in-dir`, so reattach is only offered for compatible
  sessions and falls back to a fresh start automatically if Claude refuses.

**Stop** sends `C-c` to the verified pane (a second one after 5 s for TUIs that ask twice) and waits; SIGTERM/SIGKILL only after a timeout
and explicit confirmation, targeting the verified Remote Control pid and its conversation children. **End** kills only a session whose
`@cdeck_runtime` matches (imported sessions need typed confirmation) and refuses while other programs run in it unless confirmed.
**Imported** sessions are restarted by typing the reconstructed command at an *idle* shell prompt (after showing it to you).

## Status model (`src/shared/status.ts`)

Order of evidence: tmux session/pane → pane dead (exit status) → Remote Control process present → auth error text → unanswered prompt
(`[y/N]`, `(y/n)`, Ink menus) → Claude’s status line (`·✔︎· Connected · …`) → disconnect logs → live TLS socket held by the process →
startup grace. Patterns are editable in Settings because the terminal UI can change between releases. Host failures overlay
*VM unreachable* without overwriting the last observed state.

## Conversations & environments

- Environment URL: `https://claude.ai/code?environment=<environmentId>`; conversation URL: `https://claude.ai/code/<session_…>`.
- IDs come only from Claude-emitted data (metadata files, terminal output), the user, or the extension; they are validated
  (`^session_[A-Za-z0-9]{8,64}$`). A conversation is unique by session id; it moves with process evidence.
- *Open Claude* chooses: pinned → last opened → live → newest; falls back to the environment page, then claude.ai/code (with a prompt to link).
- Routing (`src/shared/routing.ts`): runtime → account → Chrome profile. Blocks on unconfirmed account / unassigned or deleted profile;
  asks for confirmation on unverified profile, shared profile, or a process whose `CLAUDE_CONFIG_DIR` contradicts the mapping.

## Persistence (`src/main/db`)

SQLite via Node’s built-in `node:sqlite` (no native modules). Tables: `hosts`, `accounts` (unique config dir, `NULL` = default),
`projects`, `runtimes`, `conversations`, `events`, `settings`, `schema_migrations`. Migrations are append-only, run in a transaction and
tracked in `PRAGMA user_version` + `schema_migrations`. Removing a runtime keeps its conversation links; deleting a project removes only
metadata. JSON export/import merges by id and unique keys.

## Monitoring (`src/main/services/monitor.ts`, `reconcile.ts`)

One `snapshot` per host every 15 s (2 s while something is starting/stopping, ≥30 s while unreachable). `reconcile()` is pure: it matches
runtimes to panes (marker → stored pane → exact name), classifies status, assigns accounts only from process evidence, upserts conversations,
tracks git/container/folder state and emits events + notifications. Unknown Remote Control servers become “not on your dashboard” banners.
Account sign-in is re-checked every 30 min with `claude auth status --json`.

## Optional Chrome extension

`extension/` (MV3) watches tab URLs matching `https://claude.ai/code/*` only, and posts `{url, title}` to the bridge with a per-profile
token obtained through a one-time pairing code. The bridge (`src/main/services/extensionBridge.ts`) checks Host (DNS rebinding) and Origin,
stores only token hashes and updates known conversations. Unknown conversations are never attached automatically (they may be cloud/web
sessions, not ones served from the VM); they go to an inbox where you pick the session or dismiss them.
