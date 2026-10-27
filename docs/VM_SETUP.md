# Setting up the VM and the connection

Claude Deck runs on your Mac and drives a Linux VM over SSH. Everything Claude does happens on the VM, inside tmux,
so it keeps running when your Mac sleeps or Claude Deck is closed.

```
Mac ── ssh my-vm ──▶ VM
                     ├─ tmux session ─ claude remote-control   (account A: CLAUDE_CONFIG_DIR unset → ~/.claude)
                     ├─ tmux session ─ claude remote-control   (account B: CLAUDE_CONFIG_DIR=~/.claude-work)
                     └─ ~/.claude-deck/jobs/  (optional job runner for claude -p)
```

## 1. The VM

Any Linux machine you can reach over SSH works (cloud VM, home server, workstation). It needs:

| | Check |
|---|---|
| `tmux` ≥ 3.0 | `tmux -V` |
| `python3` ≥ 3.8 | `python3 --version` |
| Claude Code with Remote Control | `claude --version`, `claude remote-control --help` |
| Optional: `git`, `docker` | used only for status display |

Install Claude Code by following Anthropic's Claude Code setup documentation. If several `claude` binaries are installed,
Claude Deck shows them all and recommends the one your running servers use; you can pick another in Settings.

Give the VM enough memory for the number of sessions you plan to run (each `claude` process typically uses a few hundred
MB; the job runner can run many at once).

## 2. SSH from your Mac

Claude Deck uses the system `ssh` and your `~/.ssh/config`, so anything that works as `ssh my-vm` in Terminal works in
the app — including jump hosts and ProxyCommands. It must work **without interactive prompts** (no password or
passphrase prompts): load your key into the agent / macOS keychain.

### Plain SSH

```sshconfig
Host my-vm
  HostName 203.0.113.10
  User me
  IdentityFile ~/.ssh/id_ed25519
  AddKeysToAgent yes
  UseKeychain yes
```

### Google Cloud VM through IAP (no public IP)

```sshconfig
Host my-vm
  HostName my-instance-name
  User me
  IdentityFile ~/.ssh/google_compute_engine
  ProxyCommand gcloud compute start-iap-tunnel %h 22 --listen-on-stdin --project=my-project --zone=us-central1-a --verbosity=warning
```

`gcloud` must be signed in on the Mac (`gcloud auth login`). Organisations often expire that sign-in daily; when it
expires, Claude Deck shows "gcloud needs you to sign in again" and everything resumes after you run `gcloud auth login`.
Sessions on the VM are not affected.

### Check it

```bash
ssh -o BatchMode=yes my-vm 'tmux -V; python3 --version; claude --version'
```

If this prints three versions without asking anything, Claude Deck can connect. You don't need to configure SSH
multiplexing — Claude Deck opens its own private ControlMaster (one handshake, then fast calls) and closes it on quit.

## 3. One config directory per Claude account

Claude Code keeps an account's login and settings in a config directory: `~/.claude` by default, or whatever
`CLAUDE_CONFIG_DIR` points to. Claude Deck uses one directory per account and sets the variable **only for the process
it launches** — it never changes your shell profile or other sessions.

Create and sign in each additional account on the VM:

```bash
mkdir -p ~/.claude-work
CLAUDE_CONFIG_DIR=~/.claude-work claude          # then sign in with that account (/login)
CLAUDE_CONFIG_DIR=~/.claude-work claude auth status
```

Naming: `~/.claude-<name>` directories directly in your home folder are discovered automatically (`~/.claude-work` →
"work"). Claude Deck can also start the sign-in for you from **Claude Accounts → Sign in…** (it runs Claude's own login in
a terminal you control; it never handles your credentials).

Each account needs to be one that can use Remote Control (a claude.ai login).

## 4. Chrome profiles on the Mac

Use one Chrome profile per Claude account, each signed in to claude.ai with that account. During setup Claude Deck lists
your profiles (it reads only display metadata from Chrome's `Local State`, never cookies), suggests a match by e-mail, and
lets you **Test** each one. **Open Claude** then always opens in the right profile.

## 5. Existing sessions

If you already run `claude remote-control` in tmux, the setup assistant imports them read-only: the account is taken from
each server's own environment, conversations from Claude's session records. Nothing is restarted.

To start sessions the same way by hand:

```bash
tmux new -s my-session -c ~/my-project
CLAUDE_CONFIG_DIR=~/.claude-work claude remote-control --name "my-project · work"
```

## 6. Optional: the job runner

```bash
scripts/install-jobs.sh my-vm
```

installs `~/.claude-deck/jobs/cdeck_jobs.py`, lists the signed-in accounts in its config, and prints the `claude mcp add`
command that gives a Claude Code session the job tools. See [JOBS.md](JOBS.md).

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md). The most common issues: an SSH key that needs a passphrase (add it to the
keychain), an expired `gcloud` sign-in, and two `claude` binaries on the VM where the non-interactive shell finds an old one.
