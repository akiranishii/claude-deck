# Troubleshooting

Logs: `~/Library/Logs/Claude Deck/main.log` (no payloads, terminal output or credentials are logged).
Data: `~/Library/Application Support/Claude Deck/claude-deck.sqlite`. Per-session events: session ⋯ → *Activity & output*.

## Connecting to the VM

**“SSH authentication … failed (permission denied)”** — Claude Deck runs `ssh` with `BatchMode=yes`, so it cannot answer passphrase
prompts. Run `ssh my-vm` once in Terminal; if your key has a passphrase, `ssh-add --apple-use-keychain ~/.ssh/google_compute_engine`.

**“gcloud needs you to sign in again”** — the IAP ProxyCommand uses gcloud credentials: run `gcloud auth login` in Terminal, then *Reconnect*.

**“unreachable through IAP (the VM may be stopped)” / `4003: failed to connect to backend`** — start the VM in the Cloud console. Sessions
are shown as *VM unreachable* (last known state is kept); polling backs off to every 30 s and recovers automatically.

**“Connection timed out during banner exchange”** — the IAP tunnel was slow or rate-limited. Claude Deck fails fast instead of stacking
retries; press ⌘R or *Reconnect* after a moment.

**“The SSH ProxyCommand failed — gcloud was not found on PATH”** — Claude Deck reads PATH from your login shell (`$SHELL -lc`) and adds
`/opt/homebrew/bin`, `/usr/local/bin` and `~/google-cloud-sdk/bin`. If gcloud lives elsewhere, add it to PATH in `~/.zprofile`.

**Host key verification failed** — run `ssh my-vm` in Terminal and review the host key.

**`python3 was not found on the VM`** — install Python 3 (`sudo apt install python3`) or set its path in Settings → VM → *Python on the VM*.

## Claude Code on the VM

**Wrong or old `claude`** — Settings → VM → *Claude Code binary*. Candidates come from your interactive shell, login shell, running servers
and common locations, with their versions. Pick the one your servers use (e.g. `~/.npm-global/bin/claude`) and *Re-detect*.

**“does not support --spawn=…/--permission-mode …”** — the installed version lacks that flag. Update Claude Code on the VM or choose a supported mode.

**Session stuck in “Needs input”** — Claude is asking something in the terminal (folder trust, bypass acknowledgement, “Enable Remote Control?”).
Click *Answer in terminal* and respond; the dashboard updates on the next refresh.

**“Authentication required”** — Claude Accounts → *Sign in…*. A Terminal window runs `claude auth login` for that account’s config dir in a
temporary tmux session; Claude Deck opens the printed sign-in page in the profile you choose; paste the code back into Terminal.

**Status says “Running · connection unknown”** — the process is up but neither Claude’s status line nor a live TLS socket was observed.
Open the terminal to check. If Claude changed its wording after an update, adjust Settings → *Status detection*.

**Restart could not reattach** — Claude only reattaches (`--continue`) to sessions recorded in the last ~4 hours and not together with
`--spawn`/`--capacity`; Claude Deck then starts a fresh session automatically (the Activity panel shows `resume_failed`).

## Opening conversations

**Opens in the wrong Claude account** — each account must map to a Chrome profile that is signed in to *that* Claude login.
Claude Accounts → *Test* opens claude.ai/code in the profile; switch/sign in there, then *I checked*. Two accounts sharing one profile is
flagged because claude.ai keeps one login per profile.

**“Chrome profile … no longer exists”** — the profile was deleted or renamed on disk; pick another one (Settings → Browser → *Reload profiles*).

**Only the environment page opens** — no exact conversation link was captured yet (e.g. a session started from claude.ai before
Claude Deck saw it). Use *Link conversation* → *Paste* / *From Chrome* (macOS asks once for permission to read Chrome’s front tab),
or enable the Chrome extension.

**A saved link shows an archived/expired conversation** — links are kept for reference; *Make default* another one or remove it.

## Terminals and containers

**Open Terminal does nothing** — Claude Deck writes a short launcher to `/tmp/cdeck-<uid>/launch/` and opens it with Terminal.app.
For iTerm2, choose it in Settings (macOS asks once to allow controlling iTerm).

**Container terminal** — enable the dev container on the project (it is auto-detected from VS Code `devcontainer.local_folder` labels).
Shells open as the devcontainer’s non-root user (e.g. `vscode`) in the mapped workspace path. Claude Deck never starts, stops or rebuilds containers.

## The app won’t open

The local build is ad-hoc signed. If macOS says it is damaged or from an unidentified developer:
`xattr -dr com.apple.quarantine "/Applications/Claude Deck.app"` and open it again (or right-click → Open once).

## Reset

Quit Claude Deck, then move `~/Library/Application Support/Claude Deck` away. Nothing on the VM depends on it; your tmux sessions keep
running and can be re-imported. Use Settings → Data → *Export JSON* first if you want to keep mappings.

## Debugging the helper manually

```bash
scp resources/remote/cdeck_helper.py my-vm:/tmp/
ssh my-vm python3 /tmp/cdeck_helper.py probe
ssh my-vm python3 /tmp/cdeck_helper.py snapshot '{"capture": true}'
```
