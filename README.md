# Claude Deck

A local macOS dashboard for Claude Code **Remote Control** sessions running in tmux on a remote Linux VM, with
**several Claude accounts side by side** — plus an optional **job runner** that lets one "main" Claude Code session
start and monitor headless `claude -p` jobs on any of your accounts.

Open Claude Deck, see every project and session, click **Open Claude**, and land in the exact claude.ai
conversation — in the Chrome profile that is signed in to the right Claude account.

```
Mac (Claude Deck) ──ssh my-vm──▶ VM ──▶ tmux ──▶ claude remote-control   (per-process CLAUDE_CONFIG_DIR = one account)
Mac (Claude Deck) ──open -n -a Chrome --args --profile-directory=<P>──▶ https://claude.ai/code/session_…
Main Claude session ──MCP (stdio over ssh)──▶ VM job runner ──▶ claude -p jobs on account A, B, C … in parallel
```

## What it does

- **Projects & sessions** — folders on the VM, each with one or more Remote Control servers (any mix of accounts),
  tasks, notes, tags, pins, git branch/dirty state and dev-container status.
- **Accounts** — every Claude login is a `CLAUDE_CONFIG_DIR` on the VM plus a Chrome profile on your Mac. Launches set
  the variable for that one process only (the default account runs with it *unset*). Sign-in state comes from
  `claude auth status`.
- **Exact conversation links** — read from Claude's own session records on the VM, from URLs Claude prints, from links
  you paste, or (optionally) from a small Chrome extension. Never guessed.
- **Lifecycle** — create a folder, launch in a fresh tmux session, wait for a confirmed connection, stop with Ctrl+C,
  restart, end the tmux session. Sessions keep running when Claude Deck (or your Mac) is closed.
- **Import** — read-only discovery of the tmux sessions you already run; nothing is restarted or modified.
- **Honest status** — "Connected" requires evidence; an unreachable VM shows *VM unreachable*, never *Stopped*.
- **Job runner (optional)** — MCP tools (`run`, `run_many`, `wait`, `result`, `status`, `cancel`, `resume`, …) for a main
  agent to run `claude -p` jobs across accounts, with per-account parallelism, automatic pauses when an account hits a
  usage limit, resume-after-limit and restart-safe state. See [docs/JOBS.md](docs/JOBS.md).

## Set it up for yourself

1. **Prepare the VM and SSH** — follow [docs/VM_SETUP.md](docs/VM_SETUP.md): a Linux VM with `tmux`, `python3` and
   Claude Code; an SSH alias that works without prompts (`ssh my-vm`); one config directory per Claude account, each
   signed in.
2. **Build and open the app** on your Mac (below).
3. **Run the setup assistant** — it connects to `my-vm`, finds your accounts and existing sessions, and maps each account
   to a Chrome profile.
4. **Optional: give a main agent the job tools** — `scripts/install-jobs.sh my-vm`, then one `claude mcp add` command
   ([docs/JOBS.md](docs/JOBS.md)).

Nothing is installed on the VM for the dashboard itself: its helper is streamed over SSH on each call
([docs/REMOTE_HELPER.md](docs/REMOTE_HELPER.md)). The job runner is one Python file in `~/.claude-deck/jobs/`.

## Requirements

| Mac | VM (Linux) |
|---|---|
| macOS 13+ (developed on macOS 26, Apple Silicon) | `tmux` ≥ 3.0 |
| Node.js ≥ 22.12 + npm | `python3` ≥ 3.8 (standard library only) |
| Google Chrome (or Chrome Beta/Canary, Chromium, Brave, Edge) | Claude Code with `claude remote-control` (tested 2.1.3xx) |
| `ssh my-vm` works without prompts (key in agent/keychain; ProxyCommands such as GCP IAP are fine) | git / docker optional |

## Build and run

```bash
git clone https://github.com/<you>/claude-deck.git
cd claude-deck
npm install

npm run dev          # development: hot-reloading Electron app
npm run package      # → dist/Claude Deck-<version>-arm64.dmg / .zip and dist/mac-arm64/Claude Deck.app
npm run package:dir  # faster: only dist/mac-arm64/Claude Deck.app
```

Drag `dist/mac-arm64/Claude Deck.app` to `/Applications`. The build is ad-hoc signed for local use (no Developer ID);
on another Mac, right-click → Open the first time (see [Troubleshooting](docs/TROUBLESHOOTING.md#the-app-wont-open)).

Other scripts: `npm run build` (bundle only), `npm start` (run the built bundle), `npm run typecheck`,
`scripts/make-icons.sh`.

## First run

The setup assistant walks through five steps (all read-only until you confirm):

1. **Connect VM** — enter your SSH alias (e.g. `my-vm`). Claude Deck tests the connection, detects tmux/Python/git/docker,
   finds every `claude` binary and recommends the one your running servers use, and reads which Remote Control flags and
   permission modes that version supports.
2. **Discover sessions** — every tmux pane is classified (Remote Control server, interactive Claude, shell…). Each
   server's account is read from its own process environment.
3. **Map accounts** — name each config directory (`~/.claude` = default, `~/.claude-work`, …) and see its live sign-in
   state (e-mail, plan).
4. **Map Chrome profiles** — suggestions come from matching each profile's Google e-mail with the Claude account
   e-mail; **Test** opens claude.ai/code in that profile so you can confirm the login.
5. **Review** — import. Unconfirmed accounts or profiles are highlighted.

Run it again any time from **Settings → Data → Run setup again**.

## Everyday use

| Action | Where |
|---|---|
| Open the exact conversation in the right Chrome profile | **Open Claude** on a session (Enter on the selected row) |
| Open the Remote Control environment page | radio icon on the session row / More menu |
| Attach a terminal to the session's tmux | terminal icon (Terminal.app with `ssh -t my-vm tmux attach -t '=<name>'`) |
| New folder / existing folder / another session in a project | **New Session** (⌘N) → *Create & Launch* (required fields are marked) |
| Stop (Ctrl+C) · Start/Restart · End tmux session | session row buttons and More menu |
| Link a conversation URL manually | ⌘L, or *Link conversation* on a session |
| Task, status, notes, tags, pin, dev container | project ⋯ → *Edit project* |
| Account, permission mode, spawn mode | session ⋯ → *Edit session* |
| Sign in an account | Claude Accounts → *Sign in…* |

**Keyboard:** ⌘K command palette · ⌘N new session · ⌘R refresh · ⌘F / `/` filter · ⌘1–⌘5 filter by account ·
↑/↓ or j/k select · Enter open Claude · →/← expand/collapse · ⌘⇧L cards/list · ⌘, settings · ⌘L link conversation.

The menu-bar icon lists running sessions for one-click *Open Claude*. Notifications fire when a session needs input,
fails, loses its login or stops unexpectedly.

Claude allows one Remote Control server per account per folder; to work in parallel, start new conversations inside
the existing server (claude.ai/code or the Claude app → Code → the environment), or use another account or folder.

### Permission modes

Modes are read from the installed CLI (`default`, `acceptEdits`, `auto`, `plan`, `dontAsk`, `bypassPermissions`).
**Bypass permissions** lets Claude run commands and edit files without approval prompts; it requires an explicit
acknowledgement, is remembered per session, and is badged everywhere. Claude Deck never works around managed policies.

## Orchestrating several accounts from one main agent

`scripts/install-jobs.sh my-vm` installs the job runner; `claude mcp add …` (printed by the script) gives any Claude Code
session the tools. The main agent can then, for example, fan a prompt template out over a list of inputs, run them on
whichever account has capacity, collect the results as they finish and queue more. Details, configuration and an example
orchestration prompt: [docs/JOBS.md](docs/JOBS.md).

**Usage and terms.** Each account keeps its own usage limits; the runner only schedules within them. Check Anthropic's
terms for your plan before automating bulk work across several subscription accounts — for large automated workloads,
API keys are the supported route (the runner can run API-key accounts too; see docs/JOBS.md).

## Security & privacy

- No custom chat UI and no undocumented APIs — Claude Deck only launches `claude` and opens claude.ai.
- Nothing that could authenticate anyone is read or stored: no tokens, cookies, passwords or credential files. From
  `/proc/<pid>/environ` only `CLAUDE_CONFIG_DIR` and Claude Deck's own runtime id are kept; from Chrome's `Local State`
  only profile display metadata; from Claude's session records only whitelisted ids, names and status.
- Remote commands: one constant command (`python3 -`) with a base64 JSON request; every remote subprocess uses an
  argument vector. Terminal launchers quote both the local and the remote layer.
- Electron: `contextIsolation`, `sandbox`, no `nodeIntegration`, strict CSP, navigation and new windows blocked, one IPC
  channel validated by zod schemas with sender-frame checks.
- No network ports: the SSH connection is a private multiplexed `ssh` master; the job runner's MCP server talks over
  stdio; the optional extension bridge listens on 127.0.0.1 only and accepts nothing but claude.ai session URLs.
- Destructive actions are limited to Ctrl+C / signals to a verified Remote Control process and ending a tmux session that
  Claude Deck created (imported sessions need a typed confirmation). Folders, repositories and worktrees are never deleted.

## Tests

```bash
npm test                 # unit tests (vitest) + Python tests (helper + job runner; 1 Linux-only test skipped on macOS)
npm run typecheck
CDECK_REMOTE_TESTS=1 CDECK_TEST_HOST=my-vm npm run test:remote   # opt-in: real VM, isolated tmux server + fake claude
```

## Project layout

```
src/main/          Electron main process: SSH (ssh/), SQLite (db/), Chrome & Terminal integration, services/ (monitor, lifecycle, …)
src/preload/       contextBridge: typed invoke() + events
src/renderer/      React 19 + Tailwind 4 UI
src/shared/        types, IPC contract, routing & status rules (pure, unit-tested)
resources/remote/  cdeck_helper.py (agentless dashboard helper) and cdeck_jobs.py (job runner + MCP server)
scripts/           install-jobs.sh, make-icons.sh
extension/         optional Chrome extension (Manifest V3)
tests/             unit, python, integration
docs/              VM_SETUP.md, JOBS.md, ARCHITECTURE.md, REMOTE_HELPER.md, TROUBLESHOOTING.md
```

## License

MIT — see [LICENSE](LICENSE).
