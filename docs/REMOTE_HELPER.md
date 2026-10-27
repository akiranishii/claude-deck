# Remote helper

`resources/remote/cdeck_helper.py` is a single-file, dependency-free Python 3.8+ program that Claude Deck runs on the VM.

## Installation: none required

The helper is **agentless**: for every call Claude Deck runs

```
ssh <alias> python3 -
```

and writes the helper source to stdin followed by `entry("<base64 JSON request>")`. Python executes it and exits. Consequences:

- nothing is installed or left behind on the VM, and there is no version skew between the app and the helper;
- no daemon, no listening port, no HTTP endpoint;
- user input (paths, names) travels as base64 inside the program text and is decoded by Python — it never reaches a shell.

Over the multiplexed SSH connection a call takes ~0.3–1 s through the IAP tunnel.

### Optional: run it by hand

For troubleshooting you can copy it anywhere and use the CLI mode:

```bash
scp resources/remote/cdeck_helper.py my-vm:~/.cache/cdeck_helper.py
ssh my-vm python3 ~/.cache/cdeck_helper.py probe
ssh my-vm python3 ~/.cache/cdeck_helper.py snapshot '{"capture": true, "git_paths": ["~/myproj"]}'
ssh my-vm python3 ~/.cache/cdeck_helper.py list_config_dirs
```

Remove the file afterwards; Claude Deck never uses an installed copy.

## Operations

| op | effect |
|---|---|
| `probe` | OS, tmux/git/docker/python versions, `claude` candidates (+versions), capabilities parsed from `claude remote-control --help` and `claude auth --help`, config dirs (existence checks only) |
| `snapshot` | read-only view of tmux, Claude processes, config dirs (from `CLAUDE_CONFIG_DIR` only), TLS evidence, Claude session metadata, sanitized screen captures; optional git/container/path checks |
| `list_dir`, `check_path` | folder browser and path validation |
| `mkdir` | create a new folder (parents only inside `$HOME`); refuses if anything exists at the path |
| `auth_status` | `claude auth status --json` per config dir, returning only loggedIn/method/email/org/plan |
| `list_config_dirs`, `create_config_dir` | `~/.claude*` directories; new ones are created `0700` directly under `$HOME` |
| `launch_runtime` | new tmux session (or respawn of a dead managed pane) running Remote Control with a per-process `CLAUDE_CONFIG_DIR` |
| `stop_runtime` | Ctrl+C to the verified pane, or SIGTERM/SIGKILL to the verified Remote Control pid + its conversation children |
| `end_session` | kill a tmux session created by Claude Deck (or explicitly confirmed), refusing while programs run unless forced |
| `restart_in_shell` | type the reconstructed Remote Control command at an idle shell prompt of an imported session |
| `capture` | sanitized recent output of a pane |
| `login_start`, `login_poll`, `login_cleanup` | run `claude auth login` for one config dir in a temporary tmux session; report the sign-in URL |

Requests may include `tmux_socket` to target an isolated tmux server (`tmux -L`), used by the integration tests.

## What it reads — and never reads

Reads: tmux listings; `/proc/<pid>/{stat,cmdline,cwd,exe,fd}` for the user’s own processes; `/proc/net/tcp*` (socket states only);
from `/proc/<pid>/environ` **only** `CLAUDE_CONFIG_DIR` and `CLAUDE_DECK_RUNTIME_ID`; Claude’s `sessions/<pid>.json` and
`projects/*/bridge-pointer.json` (whitelisted fields: session/environment ids, names, status, timestamps, pid/start time);
`git rev-parse/status/log` with `GIT_OPTIONAL_LOCKS=0`; `docker ps/inspect` labels and mounts.

Never reads: `.credentials.json`, `sessions/*.key`, transcripts, `history.jsonl`, shell rc files, or any other environment variable.
Screen captures are stripped of escape sequences, QR blocks are collapsed and token-like strings (API keys, JWTs, bearer tokens, OAuth
`code`/`state` parameters, long mixed-case secrets) are redacted before leaving the VM.
