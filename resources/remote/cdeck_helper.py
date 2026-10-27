#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Claude Deck remote helper (protocol 1).

How it runs
-----------
Claude Deck streams this file over SSH for every call:

    ssh <alias> python3 -        # program text on stdin, ending with entry("<base64 request>")

Nothing is installed on the VM, no daemon is started and no network port is opened.
The request is a base64-encoded JSON object appended by the desktop app, so no
user-controlled text is ever interpreted by a remote shell. Every subprocess is
started with an argument vector (never shell=True).

For manual troubleshooting you can copy this file to the VM and run, e.g.:

    python3 cdeck_helper.py probe
    python3 cdeck_helper.py snapshot '{"capture": true}'

Privacy rules enforced here
---------------------------
* Never reads Claude credential files (.credentials.json), session *.key files,
  transcripts, history.jsonl or shell rc files.
* From /proc/<pid>/environ only CLAUDE_CONFIG_DIR and CLAUDE_DECK_RUNTIME_ID are
  kept; everything else is discarded immediately.
* From Claude's local metadata only whitelisted, non-secret fields are returned
  (session ids, environment ids, names, status).
* Terminal output is stripped of escape sequences, QR blocks are collapsed and
  token-like strings are redacted before leaving the VM.
* Destructive actions are limited to: sending Ctrl+C / signals to a verified
  Claude process, and killing a tmux session that Claude Deck created (or that
  the user explicitly confirmed). Directories are only ever created, never
  removed or overwritten.
"""

import base64
import glob
import json
import os
import pwd
import re
import shlex
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import traceback

HELPER_VERSION = "1.0.0"
PROTOCOL = 1
RESULT_MARKER = "__CDECK_RESULT__"

PROC_ROOT = "/proc"  # tests point this at a fake tree
TMUX_SOCKET = None  # per request: isolated tmux server (-L name), used by tests
SEP = "\x1f"  # field separator for tmux format strings

PERMISSION_MODES = ("default", "acceptEdits", "auto", "bypassPermissions", "dontAsk", "plan", "manual")
SPAWN_MODES = ("same-dir", "worktree", "session")
SHELL_MODES = ("interactive-login", "login", "direct")
KNOWN_SHELLS = ("bash", "zsh", "sh", "dash", "ksh", "fish", "tcsh", "csh")
POSIX_SHELLS = ("bash", "zsh", "sh", "dash", "ksh")

PANE_ID_RE = re.compile(r"^%\d{1,9}$")
SESSION_ID_RE = re.compile(r"^\$\d{1,9}$")
MANAGED_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$")
RUNTIME_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{5,63}$")
SOCKET_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
SESSION_ID_VALUE_RE = re.compile(r"^session_[A-Za-z0-9]{8,64}$")
CSE_ID_VALUE_RE = re.compile(r"^(?:cse|session)_[A-Za-z0-9]{8,64}$")
ENV_ID_VALUE_RE = re.compile(r"^env_[A-Za-z0-9]{8,64}$")
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$")
PROMPT_RE = re.compile(u"[$#%>\u276f\u00bb\u279c]\\s*$")

ENV_WHITELIST = ("CLAUDE_CONFIG_DIR", "CLAUDE_DECK_RUNTIME_ID")
SESSION_META_FIELDS = (
    "bridgeSessionId", "name", "status", "statusUpdatedAt", "startedAt",
    "updatedAt", "version", "cwd", "procStart", "kind", "entrypoint",
)
POINTER_FIELDS = ("sessionId", "environmentId", "source", "pid", "procStart")

LOGIN_URL_HOSTS = (
    "claude.ai", "claude.com", "www.claude.com", "console.anthropic.com",
    "platform.claude.com", "auth.anthropic.com", "anthropic.com", "www.anthropic.com",
)

try:
    CLK_TCK = os.sysconf("SC_CLK_TCK")
except (ValueError, OSError, AttributeError):
    CLK_TCK = 100


class HelperError(Exception):
    def __init__(self, code, message, details=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.details = details


# --------------------------------------------------------------------------- utils

def home_dir():
    return os.path.expanduser("~")


def login_shell():
    try:
        shell = pwd.getpwuid(os.getuid()).pw_shell or ""
    except KeyError:
        shell = ""
    if shell and os.path.isabs(shell) and os.access(shell, os.X_OK):
        return shell
    return "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"


def run(argv, timeout=10, env=None, cwd=None, input_text=None):
    """Run argv without a shell. Returns (code, stdout, stderr). 124 = timeout, 127 = missing."""
    try:
        proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE if input_text is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=cwd,
            start_new_session=True,
        )
    except FileNotFoundError:
        return 127, "", "command not found: %s" % argv[0]
    except OSError as exc:
        return 126, "", str(exc)
    try:
        out, err = proc.communicate(
            input=input_text.encode("utf-8") if input_text is not None else None, timeout=timeout
        )
    except subprocess.TimeoutExpired:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            proc.communicate(timeout=2)
        except Exception:  # noqa: BLE001 - best effort cleanup
            pass
        return 124, "", "timed out after %ss" % timeout
    return proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def tmux_argv(args):
    base = ["tmux"]
    if TMUX_SOCKET:
        base += ["-L", TMUX_SOCKET]
    return base + list(args)


def tmux(args, timeout=10):
    return run(tmux_argv(args), timeout=timeout)


def tmux_dir(path):
    """tmux expands '#' sequences in -c start directories (falling back to $HOME); '##' is a literal '#'."""
    return path.replace("#", "##")


def tmux_arg(value):
    """tmux treats an argument ending in ';' as a command separator; escape it as '\\;'."""
    if value.endswith("\\;"):
        raise HelperError("invalid_argument", "arguments ending in a backslash followed by ';' are not supported")
    if value.endswith(";"):
        return value[:-1] + "\\;"
    return value


def tmux_args(argv):
    return [tmux_arg(a) for a in argv]


def clamp_int(value, lo, hi, default):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, n))


def to_int(value, default=None):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def clean_str(value, field, max_len=4096, allow_empty=False):
    if not isinstance(value, str):
        raise HelperError("invalid_argument", "%s must be a string" % field)
    if CONTROL_CHARS_RE.search(value):
        raise HelperError("invalid_argument", "%s contains control characters" % field)
    if len(value) > max_len:
        raise HelperError("invalid_argument", "%s is too long" % field)
    if not allow_empty and not value.strip():
        raise HelperError("invalid_argument", "%s must not be empty" % field)
    return value


def expand_path(value, field="path"):
    """Expand ~ / $HOME only (no other variables) and normalise. Result is absolute."""
    value = clean_str(value, field).strip()
    home = home_dir()
    if value == "~" or value == "$HOME":
        value = home
    elif value.startswith("~/"):
        value = os.path.join(home, value[2:])
    elif value.startswith("$HOME/"):
        value = os.path.join(home, value[6:])
    if not os.path.isabs(value):
        raise HelperError("invalid_path", "%s must be absolute or start with ~/" % field)
    return os.path.normpath(value)


def optional_config_dir(value):
    if value is None or value == "":
        return None
    return expand_path(value, "config_dir")


def validate_pane_id(value):
    if not isinstance(value, str) or not PANE_ID_RE.match(value):
        raise HelperError("invalid_argument", "invalid tmux pane id")
    return value


def validate_runtime_id(value):
    if not isinstance(value, str) or not RUNTIME_ID_RE.match(value):
        raise HelperError("invalid_argument", "invalid runtime id")
    return value


def validate_managed_name(value):
    if not isinstance(value, str) or not MANAGED_NAME_RE.match(value):
        raise HelperError(
            "invalid_argument",
            "tmux session names created by Claude Deck may only contain letters, digits, '-' and '_'",
        )
    return value


def validate_exe(value, field="claude_path"):
    path = expand_path(value, field)
    if not os.path.isfile(path) or not os.access(path, os.X_OK):
        raise HelperError("claude_missing", "%s is not an executable file: %s" % (field, path))
    return path


def safe_readlink(path):
    try:
        return os.readlink(path)
    except OSError:
        return None


def read_json_limited(path, max_bytes):
    try:
        st = os.stat(path)
        if not stat.S_ISREG(st.st_mode) or st.st_size > max_bytes:
            return None
        with open(path, "rb") as fh:
            return json.loads(fh.read().decode("utf-8", "replace"))
    except (OSError, ValueError):
        return None


def str_or_none(value, max_len=300):
    if value is None:
        return None
    if isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return value[:max_len]
    return None


# ------------------------------------------------------------- sanitising output

ANSI_RE = re.compile(
    r"\x1b\[[0-?]*[ -/]*[@-~]"  # CSI
    r"|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC
    r"|\x1b[PX^_][^\x1b]*\x1b\\"  # DCS/SOS/PM/APC
    r"|\x1b[@-Z\\-_]"  # 2-byte sequences
    r"|\x1b."
)
CTRL_RE = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
QR_CHARS = set(u"█▀▄▌▐░▒▓■▆▇▅▃▂▁▉▊▋▍▎▏")
SAFE_ID_RE = re.compile(r"^(?:session|cse|env|ccpool)_[A-Za-z0-9]{8,64}$")
LONG_TOKEN_RE = re.compile(r"[A-Za-z0-9_\-+=]{40,}")
REDACTIONS = (
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)"), "[redacted private key]"),
    (re.compile(r"\bsk-ant-[A-Za-z0-9_\-]{6,}"), "sk-ant-[redacted]"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}"), "[redacted jwt]"),
    (re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{30,})"), "[redacted token]"),
    (re.compile(r"(?i)([?&#](?:code|token|access_token|refresh_token|id_token|state|code_verifier|key|sig|signature|password)=)[^&\s#\"']+"), r"\1[redacted]"),
    (re.compile(r"(?i)\b((?:bearer|basic)\s+)[A-Za-z0-9_\-.=+/]{8,}"), r"\1[redacted]"),
    (re.compile(r"(?i)\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret|password|passwd|authorization|cookie|session[_-]?token)\s*[:=]\s*[\"']?(?:(?:bearer|basic|token)\s+)?)(?!\[redacted)[^\s\"',;]{4,}"), r"\1[redacted]"),
)


def looks_secret(token):
    if SAFE_ID_RE.match(token):
        return False
    classes = sum(1 for rx in ("[a-z]", "[A-Z]", "[0-9]") if re.search(rx, token))
    if classes >= 3:
        return True
    return len(token) >= 64 and classes >= 2


def redact(text):
    for rx, repl in REDACTIONS:
        text = rx.sub(repl, text)
    return LONG_TOKEN_RE.sub(lambda m: "[redacted]" if looks_secret(m.group(0)) else m.group(0), text)


def is_qr_line(line):
    stripped = line.strip()
    if len(stripped) < 8:
        return False
    blocks = sum(1 for ch in stripped if ch in QR_CHARS)
    visible = sum(1 for ch in stripped if not ch.isspace())
    return blocks >= 8 and blocks * 2 >= visible


def strip_ansi(text):
    return ANSI_RE.sub("", text or "")


def sanitize_lines(text, max_lines=40, max_len=400):
    """Plain, redacted lines; QR codes collapsed; trailing blank lines removed."""
    out = []
    in_qr = False
    for raw in strip_ansi(text).split("\n"):
        line = CTRL_RE.sub("", raw).rstrip()
        if is_qr_line(line):
            if not in_qr:
                out.append("[QR code]")
                in_qr = True
            continue
        in_qr = False
        line = redact(line)
        if len(line) > max_len:
            line = line[:max_len] + u"…"
        if not line.strip() and out and not out[-1].strip():
            continue  # collapse runs of blank lines
        out.append(line)
    while out and not out[-1].strip():
        out.pop()
    while out and not out[0].strip():
        out.pop(0)
    return out[-max_lines:]


# ------------------------------------------------------------------ process table

def boot_time():
    try:
        with open(os.path.join(PROC_ROOT, "stat")) as fh:
            for line in fh:
                if line.startswith("btime "):
                    return int(line.split()[1])
    except (OSError, ValueError):
        pass
    return None


def start_epoch(start_ticks, btime):
    if btime is None:
        return None
    try:
        return btime + int(start_ticks) / float(CLK_TCK)
    except (TypeError, ValueError):
        return None


def read_stat(pid):
    """Return (state, ppid, pgrp, tpgid, start, comm) for pid, or None."""
    try:
        with open(os.path.join(PROC_ROOT, str(pid), "stat"), "rb") as fh:
            raw = fh.read().decode("utf-8", "replace")
    except OSError:
        return None
    lp = raw.find("(")
    rp = raw.rfind(")")
    if lp < 0 or rp < 0:
        return None
    rest = raw[rp + 2:].split()
    if len(rest) < 20:
        return None
    try:
        return rest[0], int(rest[1]), int(rest[2]), int(rest[5]), rest[19], raw[lp + 1:rp]
    except ValueError:
        return None


def read_proc_table(uid):
    procs = {}
    try:
        names = os.listdir(PROC_ROOT)
    except OSError:
        return procs
    for name in names:
        if not name.isdigit():
            continue
        pid = int(name)
        base = os.path.join(PROC_ROOT, name)
        try:
            if os.stat(base).st_uid != uid:
                continue
        except OSError:
            continue
        st = read_stat(pid)
        if st is None:
            continue
        try:
            with open(os.path.join(base, "cmdline"), "rb") as fh:
                cmd_raw = fh.read()
        except OSError:
            continue
        argv = [a.decode("utf-8", "replace") for a in cmd_raw.split(b"\0") if a]
        state, ppid, pgrp, tpgid, start, comm = st
        procs[pid] = {
            "pid": pid, "ppid": ppid, "pgrp": pgrp, "tpgid": tpgid, "state": state,
            "comm": comm, "start": start, "argv": argv, "children": [],
        }
    for proc in procs.values():
        parent = procs.get(proc["ppid"])
        if parent is not None:
            parent["children"].append(proc["pid"])
    return procs


def descendants(procs, pid, limit=5000):
    out = []
    stack = list(procs.get(pid, {}).get("children", []))
    while stack and len(out) < limit:
        child = stack.pop()
        out.append(child)
        stack.extend(procs.get(child, {}).get("children", []))
    return out


def process_alive(pid, start):
    st = read_stat(pid)
    if st is None:
        return False
    if start is not None and st[4] != str(start):
        return False  # pid reused
    return st[0] not in ("Z", "X")


def read_whitelisted_env(pid):
    """Only CLAUDE_CONFIG_DIR / CLAUDE_DECK_RUNTIME_ID are kept. None = unreadable."""
    try:
        with open(os.path.join(PROC_ROOT, str(pid), "environ"), "rb") as fh:
            raw = fh.read()
    except OSError:
        return None
    found = {}
    for entry in raw.split(b"\0"):
        key, sep, value = entry.partition(b"=")
        if not sep:
            continue
        try:
            k = key.decode("ascii")
        except UnicodeDecodeError:
            continue
        if k in ENV_WHITELIST:
            found[k] = value.decode("utf-8", "replace")[:1024]
    raw = None
    return found


def config_dir_info(env, cwd=None):
    """Which Claude config dir a process uses: env (explicit), default (unset) or unknown."""
    if env is None:
        return {"state": "unknown", "value": None}
    value = env.get("CLAUDE_CONFIG_DIR")
    if value is None or value == "":
        return {"state": "default", "value": None}
    if value.startswith("~"):
        value = os.path.expanduser(value)
    elif not os.path.isabs(value) and cwd:
        value = os.path.join(cwd, value)
    return {"state": "env", "value": os.path.normpath(value)}


def effective_config_dir(info):
    if info.get("state") == "env" and info.get("value"):
        return info["value"]
    if info.get("state") == "default":
        return os.path.join(home_dir(), ".claude")
    return None


# ------------------------------------------------------------- claude processes

CLAUDE_NAME_RE = re.compile(r"(?:^|/)(?:claude|claude\.exe)$")
CLAUDE_SUBCOMMANDS = (
    "auth", "mcp", "plugin", "plugins", "doctor", "update", "upgrade", "install", "agents",
    "attach", "logs", "setup-token", "stop", "kill", "rm", "respawn", "import", "purge",
    "ultrareview", "gateway", "auto-mode", "config", "migrate-installer",
)


def claude_argv_split(argv):
    """(binary, args) if argv is a Claude Code invocation, else None."""
    if not argv:
        return None
    a0 = argv[0]
    if CLAUDE_NAME_RE.search(a0):
        return a0, argv[1:]
    if os.path.basename(a0) in ("node", "nodejs", "bun") and len(argv) >= 2:
        a1 = argv[1]
        if CLAUDE_NAME_RE.search(a1) or "/@anthropic-ai/claude-code/" in a1:
            return a1, argv[2:]
    return None


def opt_value(args, names):
    for i, arg in enumerate(args):
        for name in names:
            if arg == name and i + 1 < len(args):
                return args[i + 1]
            if arg.startswith(name + "="):
                return arg[len(name) + 1:]
    return None


def has_flag(args, names):
    return any(a in names for a in args)


def classify_claude(args):
    if args and args[0] == "remote-control":
        return "rc-server"
    if "--sdk-url" in args or any(a.startswith("--sdk-url=") for a in args):
        return "rc-session"
    if "--remote-control" in args or any(a.startswith("--remote-control=") for a in args):
        return "interactive-rc"
    if "-p" in args or "--print" in args:
        return "print"
    if args and args[0] in CLAUDE_SUBCOMMANDS:
        return "subcommand"
    return "interactive"


def bounded(value, n=200):
    return value[:n] if isinstance(value, str) else value


def parse_rc_server_args(args):
    a = args[1:] if args and args[0] == "remote-control" else list(args)
    create = None
    if has_flag(a, ("--no-create-session-in-dir",)):
        create = False
    elif has_flag(a, ("--create-session-in-dir",)):
        create = True
    chrome = None
    if has_flag(a, ("--no-chrome",)):
        chrome = False
    elif has_flag(a, ("--chrome",)):
        chrome = True
    return {
        "name": bounded(opt_value(a, ("--name",))),
        "spawn": bounded(opt_value(a, ("--spawn",)), 40),
        "permission_mode": bounded(opt_value(a, ("--permission-mode",)), 40),
        "capacity": to_int(opt_value(a, ("--capacity",))),
        "continue": has_flag(a, ("-c", "--continue")),
        "session_id": bounded(opt_value(a, ("--session-id",)), 80),
        "create_session_in_dir": create,
        "chrome": chrome,
        "verbose": has_flag(a, ("-v", "--verbose")),
        "debug": any(x == "-d" or x.startswith("--debug") for x in a),
    }


def parse_rc_session_args(args):
    sid = opt_value(args, ("--session-id",))
    if not sid:
        match = re.search(r"/sessions/((?:cse|session)_[A-Za-z0-9]{8,64})", opt_value(args, ("--sdk-url",)) or "")
        sid = match.group(1) if match else None
    if sid and not CSE_ID_VALUE_RE.match(sid):
        sid = None
    model = opt_value(args, ("--model",))
    return {
        "cse_id": sid,
        "model": bounded(model, 80) if model else None,
        "permission_mode": bounded(opt_value(args, ("--permission-mode",)), 40),
    }


def read_session_meta(config_dir, pid):
    if not config_dir:
        return None
    data = read_json_limited(os.path.join(config_dir, "sessions", "%d.json" % pid), 256 * 1024)
    if not isinstance(data, dict):
        return None
    out = {}
    for key in SESSION_META_FIELDS:
        value = str_or_none(data.get(key))
        if value is not None:
            out[key] = value
    bridge = out.get("bridgeSessionId")
    if bridge is not None and not (isinstance(bridge, str) and SESSION_ID_VALUE_RE.match(bridge)):
        out.pop("bridgeSessionId", None)
    return out


def read_bridge_pointers(config_dir, limit=3000):
    out = []
    if not config_dir:
        return out
    for path in glob.glob(os.path.join(config_dir, "projects", "*", "bridge-pointer.json"))[:limit]:
        data = read_json_limited(path, 64 * 1024)
        if not isinstance(data, dict):
            continue
        entry = {k: str_or_none(data.get(k)) for k in POINTER_FIELDS}
        if entry.get("sessionId") and not SESSION_ID_VALUE_RE.match(str(entry["sessionId"])):
            entry["sessionId"] = None
        if entry.get("environmentId") and not ENV_ID_VALUE_RE.match(str(entry["environmentId"])):
            entry["environmentId"] = None
        try:
            entry["mtime"] = os.stat(path).st_mtime
        except OSError:
            entry["mtime"] = None
        out.append(entry)
    return out


def read_tcp_table():
    """inode -> (state_hex, remote_port) from the kernel's TCP tables (no payloads)."""
    table = {}
    for name in ("tcp", "tcp6"):
        try:
            with open(os.path.join(PROC_ROOT, "net", name)) as fh:
                lines = fh.read().splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            parts = line.split()
            if len(parts) < 10:
                continue
            try:
                port = int(parts[2].rsplit(":", 1)[1], 16)
            except (IndexError, ValueError):
                continue
            table[parts[9]] = (parts[3], port)
    return table


def socket_inodes(pid):
    found = set()
    fd_dir = os.path.join(PROC_ROOT, str(pid), "fd")
    try:
        fds = os.listdir(fd_dir)
    except OSError:
        return found
    for fd in fds:
        target = safe_readlink(os.path.join(fd_dir, fd))
        if target and target.startswith("socket:["):
            found.add(target[8:-1])
    return found


def tcp_evidence(pid, table):
    """Count ESTABLISHED (state 01) TCP connections held by pid; port 443 = Anthropic API."""
    established = 0
    https = 0
    for inode in socket_inodes(pid):
        entry = table.get(inode)
        if entry and entry[0] == "01":
            established += 1
            if entry[1] == 443:
                https += 1
    return {"established": established, "https": https}


def foreground_info(procs, root_pid, claude):
    root = procs.get(root_pid)
    if root is None:
        return {"kind": "unknown"}
    tpgid = root["tpgid"]
    leader = procs.get(tpgid)
    if leader is None:
        members = [procs[p] for p in [root_pid] + descendants(procs, root_pid) if procs[p]["pgrp"] == tpgid]
        leader = members[0] if members else None
    if leader is None:
        return {"kind": "unknown", "comm": root["comm"][:32]}
    if leader["pid"] in claude:
        return {"kind": "claude", "claude_kind": claude[leader["pid"]][2], "pid": leader["pid"]}
    if leader["pid"] == root_pid and leader["comm"].lstrip("-") in KNOWN_SHELLS:
        return {"kind": "shell-idle", "comm": leader["comm"][:32], "children": len(root["children"])}
    return {"kind": "other", "comm": leader["comm"][:32], "pid": leader["pid"]}


def nearest_claude_ancestor(procs, claude, pid, kinds):
    seen = 0
    cur = procs.get(pid, {}).get("ppid")
    while cur and seen < 64:
        if cur in claude and claude[cur][2] in kinds:
            return cur
        cur = procs.get(cur, {}).get("ppid")
        seen += 1
    return None


# ------------------------------------------------------------------------- tmux

SESSION_FIELDS = (
    "session_id", "session_name", "session_windows", "session_attached", "session_created",
    "session_activity", "@cdeck_runtime", "@cdeck_managed", "@cdeck_login",
)
PANE_FIELDS = (
    "session_id", "session_name", "window_id", "window_index", "window_name", "pane_id",
    "pane_index", "pane_pid", "pane_current_command", "pane_current_path", "pane_dead",
    "pane_dead_status", "pane_width", "pane_height", "pane_active", "window_active",
)


def tmux_list(kind, fields, extra=()):
    fmt = SEP.join("#{%s}" % f for f in fields)
    code, out, err = tmux([kind, "-F", fmt] + list(extra), timeout=10)
    if code == 127:
        raise HelperError("tmux_missing", "tmux is not installed on this host")
    if code != 0:
        low = err.lower()
        if "no server running" in low or "error connecting" in low or "no such file or directory" in low:
            return None
        raise HelperError("tmux_error", (err.strip() or "tmux %s failed" % kind)[:400])
    rows = []
    for line in out.split("\n"):
        if not line:
            continue
        parts = line.split(SEP)
        if len(parts) != len(fields):
            continue
        rows.append(dict(zip(fields, parts)))
    return rows


def list_sessions():
    return tmux_list("list-sessions", SESSION_FIELDS)


def list_panes():
    return tmux_list("list-panes", PANE_FIELDS, ["-a"]) or []


def find_session(name):
    for sess in list_sessions() or []:
        if sess["session_name"] == name:
            return sess
    return None


def find_pane(pane_id):
    for pane in list_panes():
        if pane["pane_id"] == pane_id:
            return pane
    return None


def session_out(sess):
    return {
        "session_id": sess["session_id"],
        "name": sess["session_name"],
        "windows": to_int(sess["session_windows"], 0),
        "attached": to_int(sess["session_attached"], 0),
        "created": to_int(sess["session_created"]),
        "activity": to_int(sess["session_activity"]),
        "runtime_marker": sess.get("@cdeck_runtime") or None,
        "managed": sess.get("@cdeck_managed") == "1",
        "login": sess.get("@cdeck_login") == "1",
    }


def capture_pane(pane_id, history=0, join=True):
    args = ["capture-pane", "-p"]
    if join:
        args.append("-J")
    args += ["-t", pane_id]
    if history:
        args += ["-S", "-%d" % history]
    code, out, _err = tmux(args, timeout=10)
    return out if code == 0 else None


ENV_URL_RE = re.compile(r"https://claude\.ai/code\?environment=(env_[A-Za-z0-9]{8,64})")
SESSION_URL_RE = re.compile(r"https://claude\.ai/code/(session_[A-Za-z0-9]{8,64})")
STATUS_LINE_RE = re.compile(u"^\\s*·(.{1,4})·\\s+(\\S.*?)\\s*$")
CAPACITY_RE = re.compile(r"Capacity:\s*(\d+)\s*/\s*(\d+)(?:\s*·\s*(.*))?")
LOG_LINE_RE = re.compile(r"^\s*\[(\d{1,2}:\d{2}:\d{2})\]\s+(\S.*)$")


def unique_tail(items, n):
    seen = set()
    out = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out[-n:]


def parse_screen(visible, history_text=""):
    lines = sanitize_lines(visible or "", max_lines=80)
    status_line = None
    state_word = None
    capacity = None
    last_log = None
    for line in lines:
        match = STATUS_LINE_RE.match(line)
        if match:
            status_line = line.strip()
            state_word = match.group(2).split(u" · ")[0].strip()[:60]
        cap = CAPACITY_RE.search(line)
        if cap:
            capacity = {"used": int(cap.group(1)), "max": int(cap.group(2)), "note": (cap.group(3) or "").strip()[:160]}
        log = LOG_LINE_RE.match(line)
        if log:
            last_log = {"time": log.group(1), "text": log.group(2)[:200]}
    raw = strip_ansi(history_text or "") + "\n" + strip_ansi(visible or "")
    nonblank = [l for l in lines if l.strip()]
    return {
        "status_line": status_line,
        "state_word": state_word,
        "capacity": capacity,
        "last_log": last_log,
        "env_ids": unique_tail(ENV_URL_RE.findall(raw), 5),
        "session_ids": unique_tail(SESSION_URL_RE.findall(raw), 50),
        "screen_tail": nonblank[-30:],
    }


# ---------------------------------------------------------------------- probing

def first_line(text):
    for line in (text or "").splitlines():
        if line.strip():
            return line.strip()
    return ""


def claude_version(path):
    code, out, err = run([path, "--version"], timeout=20, cwd=home_dir())
    if code != 0:
        return None, first_line(err)[:200] or "exit %d" % code
    match = re.search(r"(\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.]+)?)", out)
    return (match.group(1) if match else first_line(out)[:60]), None


def claude_candidates(running_exes=()):
    cands = []

    def add(path, source):
        if not path:
            return
        path = os.path.expanduser(path)
        if not os.path.isabs(path) or not os.path.isfile(path) or not os.access(path, os.X_OK):
            return
        real = os.path.realpath(path)
        for cand in cands:
            if cand["realpath"] == real:
                if source not in cand["sources"]:
                    cand["sources"].append(source)
                return
        cands.append({"path": path, "realpath": real, "sources": [source]})

    shell = login_shell()
    shell_name = os.path.basename(shell)
    if shell_name in POSIX_SHELLS:
        for flags, source in (("-lic", "interactive-shell"), ("-lc", "login-shell")):
            code, out, _ = run([shell, flags, "command -v claude"], timeout=12, cwd=home_dir())
            for line in reversed(out.splitlines()):
                line = line.strip()
                if line.startswith("/"):
                    add(line, source)
                    break
    for exe in running_exes:
        add(exe, "running-server")
    add(shutil.which("claude"), "ssh-path")
    for path in ("~/.local/bin/claude", "~/.npm-global/bin/claude", "~/.claude/local/claude",
                 "/usr/local/bin/claude", "/usr/bin/claude", "~/.bun/bin/claude"):
        add(path, "common-location")
    for path in sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/claude"))):
        add(path, "nvm")
    for cand in cands:
        cand["version"], cand["error"] = claude_version(cand["path"])
    return cands


def version_key(version):
    parts = re.findall(r"\d+", version or "")
    return tuple(int(p) for p in parts[:4]) if parts else (0,)


def recommend_candidate(cands):
    usable = [c for c in cands if c.get("version")]
    if not usable:
        return None
    for source in ("running-server", "interactive-shell"):
        hits = [c for c in usable if source in c["sources"]]
        if hits:
            return max(hits, key=lambda c: version_key(c["version"]))["path"]
    return max(usable, key=lambda c: version_key(c["version"]))["path"]


def parse_rc_help(text):
    text = strip_ansi(text)
    flags = sorted(set(re.findall(r"(--\[no-\][a-z][a-z-]*|--[a-z][a-z-]*)", text)))
    spawn_modes = []
    match = re.search(r"--spawn\s+<mode>\s+Spawn mode:\s*([A-Za-z ,\-]+)", text)
    if match:
        spawn_modes = [s.strip() for s in match.group(1).split(",") if s.strip() and s.strip() in SPAWN_MODES]
    perm_modes = []
    match = re.search(r"--permission-mode\s+<mode>[\s\S]{0,240}?\(([A-Za-z, ]+)\)", text)
    if match:
        perm_modes = [s.strip() for s in match.group(1).split(",") if s.strip()]

    def has(flag):
        return flag in flags

    return {
        "rc_supported": "Remote Control" in text or "remote-control" in text,
        "flags": flags,
        "spawn_modes": spawn_modes,
        "permission_modes": perm_modes,
        "supports_name": has("--name"),
        "supports_spawn": has("--spawn"),
        "supports_permission_mode": has("--permission-mode"),
        "supports_continue": has("--continue"),
        "supports_session_id": has("--session-id"),
        "supports_capacity": has("--capacity"),
        "supports_create_session_in_dir": has("--[no-]create-session-in-dir"),
        "supports_chrome": has("--[no-]chrome"),
    }


def claude_capabilities(claude_path):
    caps = {"claude_path": claude_path}
    caps["version"], caps["version_error"] = claude_version(claude_path)
    code, out, err = run([claude_path, "remote-control", "--help"], timeout=25, cwd=home_dir())
    caps.update(parse_rc_help(out + "\n" + err))
    if code != 0 and not caps["flags"]:
        caps["rc_supported"] = False
        caps["rc_help_error"] = first_line(err)[:200]
    code, out, err = run([claude_path, "auth", "--help"], timeout=20, cwd=home_dir())
    caps["auth_status_supported"] = code == 0 and re.search(r"^\s+status\b", out, re.M) is not None
    caps["auth_login_supported"] = code == 0 and re.search(r"^\s+login\b", out, re.M) is not None
    return caps


def tool_version(argv):
    code, out, err = run(argv, timeout=8)
    if code != 0:
        return None
    return first_line(out or err)[:80]


def os_pretty_name():
    data = {}
    try:
        with open("/etc/os-release") as fh:
            for line in fh:
                key, _, value = line.strip().partition("=")
                data[key] = value.strip('"')
    except OSError:
        pass
    return data.get("PRETTY_NAME")


def list_config_dirs():
    home = home_dir()
    out = []
    try:
        names = sorted(os.listdir(home))
    except OSError:
        return out
    for name in names:
        if name != ".claude" and not re.match(r"^\.claude[-_.][A-Za-z0-9][A-Za-z0-9._-]{0,60}$", name):
            continue
        path = os.path.join(home, name)
        if not os.path.isdir(path):
            continue
        markers = {}
        for marker in (".credentials.json", "settings.json", "projects", "sessions", ".claude.json"):
            markers[marker] = os.path.exists(os.path.join(path, marker))  # existence only, never read
        if not any(markers.values()):
            continue
        try:
            mtime = os.stat(path).st_mtime
        except OSError:
            mtime = None
        out.append({
            "path": path,
            "name": name,
            "is_default_dir": name == ".claude",
            "has_credentials": markers[".credentials.json"],
            "has_projects": markers["projects"],
            "mtime": mtime,
        })
    return out


def op_probe(args):
    uid = os.getuid()
    try:
        user = pwd.getpwuid(uid).pw_name
    except KeyError:
        user = str(uid)
    info = {
        "helper_version": HELPER_VERSION,
        "protocol": PROTOCOL,
        "python": sys.version.split()[0],
        "hostname": socket.gethostname(),
        "user": user,
        "uid": uid,
        "home": home_dir(),
        "login_shell": login_shell(),
        "os": os_pretty_name(),
        "kernel": os.uname().release,
        "arch": os.uname().machine,
        "tmux": {"path": shutil.which("tmux"), "version": tool_version(tmux_argv(["-V"]))},
        "git": {"path": shutil.which("git"), "version": tool_version(["git", "--version"])},
        "docker": {"path": shutil.which("docker")},
        "projects_dir_exists": os.path.isdir(os.path.join(home_dir(), "projects")),
    }
    if info["docker"]["path"]:
        code, out, err = run(["docker", "info", "--format", "{{.ServerVersion}}"], timeout=8)
        info["docker"]["accessible"] = code == 0
        info["docker"]["version"] = first_line(out) if code == 0 else None
        info["docker"]["error"] = None if code == 0 else first_line(err)[:200]
    running_exes = []
    if args.get("include_claude", True):
        procs = read_proc_table(uid)
        for pid, proc in procs.items():
            split = claude_argv_split(proc["argv"])
            if split and classify_claude(split[1]) == "rc-server":
                exe = safe_readlink(os.path.join(PROC_ROOT, str(pid), "exe"))
                if exe and not exe.endswith(" (deleted)"):
                    running_exes.append(exe)
        cands = claude_candidates(running_exes)
        info["claude_candidates"] = cands
        info["claude_recommended"] = recommend_candidate(cands)
        chosen = args.get("claude_path") or info["claude_recommended"]
        if chosen:
            info["capabilities"] = claude_capabilities(validate_exe(chosen))
    info["config_dirs"] = list_config_dirs()
    return info


# --------------------------------------------------------------------- snapshot

def git_info(path):
    env = dict(os.environ)
    env.update({"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"})
    if not os.path.isdir(path):
        return {"exists": False}
    code, out, _err = run(
        ["git", "-C", path, "rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir", "--abbrev-ref", "HEAD"],
        timeout=4, env=env,
    )
    if code != 0:
        return {"exists": True, "is_repo": False}
    lines = out.strip().split("\n")
    if len(lines) < 4:
        return {"exists": True, "is_repo": True}
    top, git_dir, common, branch = lines[0], lines[1], lines[2], lines[3]
    common_abs = common if os.path.isabs(common) else os.path.normpath(os.path.join(path, common))
    result = {
        "exists": True,
        "is_repo": True,
        "root": top,
        "branch": None if branch == "HEAD" else branch[:200],
        "detached": branch == "HEAD",
        "is_worktree": os.path.realpath(git_dir) != os.path.realpath(common_abs),
        "main_git_dir": os.path.realpath(common_abs),
    }
    code, out, _ = run(["git", "-C", path, "status", "--porcelain=v1", "--untracked-files=no"], timeout=6, env=env)
    result["dirty_count"] = len([l for l in out.split("\n") if l.strip()]) if code == 0 else None
    code, out, _ = run(["git", "-C", path, "log", "-1", "--format=%h%x1f%s%x1f%ct"], timeout=4, env=env)
    if code == 0 and out.strip():
        parts = out.strip().split("\x1f")
        if len(parts) == 3:
            result["last_commit"] = {"hash": parts[0][:16], "subject": redact(parts[1])[:200], "time": to_int(parts[2])}
    if result["detached"]:
        code, out, _ = run(["git", "-C", path, "rev-parse", "--short", "HEAD"], timeout=4, env=env)
        result["head"] = out.strip()[:16] if code == 0 else None
    code, out, _ = run(["git", "-C", path, "rev-list", "--left-right", "--count", "HEAD...@{u}"], timeout=4, env=env)
    if code == 0:
        nums = out.split()
        if len(nums) == 2:
            result["ahead"], result["behind"] = to_int(nums[0], 0), to_int(nums[1], 0)
    return result


def list_containers(detail_ids=()):
    if not shutil.which("docker"):
        return {"available": False, "reason": "docker is not installed"}
    fmt = SEP.join([
        "{{.ID}}", "{{.Names}}", "{{.State}}", "{{.Status}}", "{{.Image}}",
        '{{.Label "devcontainer.local_folder"}}', '{{.Label "devcontainer.config_file"}}',
    ])
    code, out, err = run(["docker", "ps", "-a", "--no-trunc", "--format", fmt], timeout=12)
    if code != 0:
        return {"available": False, "reason": first_line(err)[:200] or "docker ps failed"}
    containers = []
    for line in out.split("\n"):
        parts = line.split(SEP)
        if len(parts) != 7:
            continue
        containers.append({
            "id": parts[0][:64], "name": parts[1][:128], "state": parts[2][:32], "status": parts[3][:80],
            "image": parts[4][:200], "local_folder": parts[5] or None, "config_file": parts[6] or None,
        })
    wanted = set(detail_ids)
    for cont in containers:
        if cont["id"] not in wanted and cont["name"] not in wanted:
            continue
        code, out, _ = run(
            ["docker", "inspect", "--format", '{{json .Mounts}}' + SEP + '{{index .Config.Labels "devcontainer.metadata"}}' + SEP + "{{.Config.User}}", cont["id"]],
            timeout=10,
        )
        if code != 0:
            continue
        parts = out.strip().split(SEP)
        mounts = []
        try:
            for m in json.loads(parts[0]) or []:
                if m.get("Type") == "bind":
                    mounts.append({"source": m.get("Source"), "destination": m.get("Destination")})
        except (ValueError, TypeError, AttributeError):
            pass
        cont["mounts"] = mounts[:20]
        remote_user = None
        if len(parts) > 1 and parts[1].strip() and parts[1].strip() != "<no value>":
            try:
                for item in json.loads(parts[1]):
                    if isinstance(item, dict):
                        remote_user = item.get("remoteUser") or item.get("containerUser") or remote_user
            except (ValueError, TypeError):
                pass
        cont["remote_user"] = remote_user
        cont["config_user"] = parts[2][:64] if len(parts) > 2 else None
    return {"available": True, "containers": containers}


def op_snapshot(args):
    t0 = time.time()
    uid = os.getuid()
    capture = bool(args.get("capture", True))
    history_for = set(p for p in (args.get("history_panes") or []) if isinstance(p, str) and PANE_ID_RE.match(p))
    capture_extra = set(p for p in (args.get("capture_panes") or []) if isinstance(p, str) and PANE_ID_RE.match(p))
    history_lines = clamp_int(args.get("history_lines"), 0, 3000, 600)

    sessions = list_sessions()
    panes = list_panes() if sessions is not None else []
    procs = read_proc_table(uid)
    btime = boot_time()

    claude = {}
    for pid, proc in procs.items():
        split = claude_argv_split(proc["argv"])
        if split:
            claude[pid] = (split[0], split[1], classify_claude(split[1]))

    pane_of = {}
    for pane in panes:
        root = to_int(pane["pane_pid"])
        if root in procs:
            pane_of[root] = pane["pane_id"]
            for child in descendants(procs, root):
                pane_of[child] = pane["pane_id"]

    env_cache = {}

    def env_of(pid):
        if pid not in env_cache:
            env_cache[pid] = read_whitelisted_env(pid)
        return env_cache[pid]

    servers = []
    for pid, (_binary, cargs, kind) in claude.items():
        if kind not in ("rc-server", "interactive-rc"):
            continue
        proc = procs[pid]
        env = env_of(pid)
        cwd = safe_readlink(os.path.join(PROC_ROOT, str(pid), "cwd"))
        cfg = config_dir_info(env, cwd)
        flags = parse_rc_server_args(cargs) if kind == "rc-server" else {"name": bounded(opt_value(cargs, ("--remote-control",)))}
        servers.append({
            "pid": pid,
            "start": proc["start"],
            "started_at": start_epoch(proc["start"], btime),
            "kind": kind,
            "flags": flags,
            "config_dir": cfg,
            "runtime_marker": (env or {}).get("CLAUDE_DECK_RUNTIME_ID"),
            "exe": safe_readlink(os.path.join(PROC_ROOT, str(pid), "exe")),
            "cwd": cwd,
            "pane_id": pane_of.get(pid),
            "conversations": [],
            "pointer": None,
        })

    tcp_table = read_tcp_table() if servers else {}
    for server in servers:
        server["tcp"] = tcp_evidence(server["pid"], tcp_table)

    server_by_pid = dict((s["pid"], s) for s in servers)
    for pid, (_binary, cargs, kind) in claude.items():
        if kind != "rc-session":
            continue
        owner = nearest_claude_ancestor(procs, claude, pid, ("rc-server", "interactive-rc"))
        if owner not in server_by_pid:
            continue
        server = server_by_pid[owner]
        proc = procs[pid]
        info = parse_rc_session_args(cargs)
        env = env_of(pid)
        cfg = config_dir_info(env, server["cwd"]) if env is not None else server["config_dir"]
        meta = read_session_meta(effective_config_dir(cfg), pid)
        if meta and str(meta.get("procStart")) != str(proc["start"]):
            meta = None  # stale record from an earlier process with the same pid
        info.update({
            "pid": pid,
            "start": proc["start"],
            "started_at": start_epoch(proc["start"], btime),
            "meta": meta,
        })
        server["conversations"].append(info)

    pointer_cache = {}
    for server in servers:
        cfg_dir = effective_config_dir(server["config_dir"])
        if not cfg_dir:
            continue
        if cfg_dir not in pointer_cache:
            pointer_cache[cfg_dir] = read_bridge_pointers(cfg_dir)
        for ptr in pointer_cache[cfg_dir]:
            if str(ptr.get("pid")) == str(server["pid"]) and str(ptr.get("procStart")) == str(server["start"]):
                server["pointer"] = {"environment_id": ptr.get("environmentId"), "session_id": ptr.get("sessionId"), "source": ptr.get("source")}
                break

    pane_out = []
    for pane in panes:
        root = to_int(pane["pane_pid"])
        dead = pane["pane_dead"] == "1"
        rc_pids = [s["pid"] for s in servers if s["pane_id"] == pane["pane_id"]]
        others = []
        if root in procs:
            for pid in [root] + descendants(procs, root):
                if pid in claude and claude[pid][2] in ("interactive", "print") and nearest_claude_ancestor(procs, claude, pid, ("interactive", "print", "rc-session", "rc-server", "interactive-rc")) is None:
                    env = env_of(pid)
                    others.append({
                        "pid": pid, "kind": claude[pid][2],
                        "config_dir": config_dir_info(env, safe_readlink(os.path.join(PROC_ROOT, str(pid), "cwd"))),
                        "started_at": start_epoch(procs[pid]["start"], btime),
                    })
        entry = {
            "session_id": pane["session_id"],
            "session_name": pane["session_name"],
            "window_id": pane["window_id"],
            "window_index": to_int(pane["window_index"], 0),
            "window_name": pane["window_name"][:80],
            "pane_id": pane["pane_id"],
            "pane_index": to_int(pane["pane_index"], 0),
            "pane_pid": root,
            "current_command": pane["pane_current_command"][:64],
            "cwd": pane["pane_current_path"] or None,
            "dead": dead,
            "dead_status": to_int(pane["pane_dead_status"]),
            "width": to_int(pane["pane_width"], 0),
            "height": to_int(pane["pane_height"], 0),
            "active": pane["pane_active"] == "1" and pane["window_active"] == "1",
            "foreground": {"kind": "dead"} if dead else foreground_info(procs, root, claude),
            "rc_server_pids": rc_pids,
            "other_claude": others[:10],
            "capture": None,
        }
        if capture and (rc_pids or others or pane["pane_id"] in capture_extra or pane["pane_id"] in history_for):
            visible = capture_pane(pane["pane_id"]) or ""
            hist = capture_pane(pane["pane_id"], history=history_lines) if pane["pane_id"] in history_for else ""
            entry["capture"] = parse_screen(visible, hist or "")
        pane_out.append(entry)

    result = {
        "time": time.time(),
        "boot_time": btime,
        "tmux_running": sessions is not None,
        "sessions": [session_out(s) for s in (sessions or [])],
        "panes": pane_out,
        "servers": servers,
    }

    paths = [p for p in (args.get("check_paths") or []) if isinstance(p, str)][:300]
    checks = {}
    for raw in paths:
        try:
            path = expand_path(raw)
        except HelperError:
            continue
        checks[raw] = {"exists": os.path.exists(path), "is_dir": os.path.isdir(path)}
    result["paths"] = checks

    git_paths = [p for p in (args.get("git_paths") or []) if isinstance(p, str)][:60]
    gits = {}
    git_deadline = time.time() + clamp_int(args.get("git_budget_seconds"), 1, 60, 12)
    for raw in git_paths:
        if time.time() > git_deadline:
            gits[raw] = {"exists": True, "skipped": True}  # out of time; checked first next round
            continue
        try:
            gits[raw] = git_info(expand_path(raw))
        except HelperError:
            continue
    result["git"] = gits

    if args.get("containers"):
        result["containers"] = list_containers(args.get("container_details") or [])

    result["elapsed_ms"] = int((time.time() - t0) * 1000)
    return result


# ----------------------------------------------------------------- filesystem ops

def find_git_root(path):
    cur = path
    for _ in range(64):
        if os.path.exists(os.path.join(cur, ".git")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent
    return None


def op_list_dir(args):
    path = expand_path(args.get("path") or "~")
    show_hidden = bool(args.get("show_hidden"))
    if not os.path.exists(path):
        raise HelperError("not_found", "No such directory: %s" % path)
    if not os.path.isdir(path):
        raise HelperError("not_a_directory", "Not a directory: %s" % path)
    entries = []
    truncated = False
    try:
        with os.scandir(path) as it:
            for entry in it:
                if not show_hidden and entry.name.startswith("."):
                    continue
                try:
                    if not entry.is_dir(follow_symlinks=True):
                        continue
                except OSError:
                    continue
                entries.append({
                    "name": entry.name,
                    "is_git": os.path.exists(os.path.join(entry.path, ".git")),
                    "is_symlink": entry.is_symlink(),
                })
                if len(entries) >= 2000:
                    truncated = True
                    break
    except PermissionError:
        raise HelperError("permission_denied", "Permission denied: %s" % path)
    entries.sort(key=lambda e: e["name"].lower())
    return {
        "path": path,
        "parent": os.path.dirname(path) if path != "/" else None,
        "home": home_dir(),
        "entries": entries,
        "truncated": truncated,
        "writable": os.access(path, os.W_OK),
        "git_root": find_git_root(path),
    }


def op_check_path(args):
    path = expand_path(args.get("path"))
    parent = os.path.dirname(path)
    exists = os.path.exists(path)
    result = {
        "path": path,
        "exists": exists,
        "is_dir": os.path.isdir(path),
        "writable": os.access(path, os.W_OK) if exists else None,
        "parent": parent,
        "parent_exists": os.path.isdir(parent),
        "parent_writable": os.access(parent, os.W_OK) if os.path.isdir(parent) else None,
        "inside_home": path == home_dir() or path.startswith(home_dir().rstrip("/") + "/"),
        "git_root": find_git_root(path if os.path.isdir(path) else parent) if (exists or os.path.isdir(parent)) else None,
    }
    if result["is_dir"]:
        result["git"] = git_info(path)
    return result


def op_mkdir(args):
    """Create a new project folder. Never touches an existing path."""
    path = expand_path(args.get("path"))
    home = home_dir().rstrip("/")
    if path in ("/", home):
        raise HelperError("invalid_path", "Refusing to create %s" % path)
    if os.path.lexists(path):
        raise HelperError("exists", "%s already exists; choose 'Use existing folder' instead" % path)
    name = os.path.basename(path)
    if name.startswith("-") or name in (".", ".."):
        raise HelperError("invalid_path", "Invalid folder name: %s" % name)
    parent = os.path.dirname(path)
    inside_home = path.startswith(home + "/")
    if not os.path.isdir(parent):
        if not inside_home:
            raise HelperError("parent_missing", "Parent directory does not exist: %s" % parent)
        os.makedirs(parent, mode=0o755, exist_ok=True)
    try:
        os.mkdir(path, 0o755)
    except FileExistsError:
        raise HelperError("exists", "%s already exists" % path)
    except PermissionError:
        raise HelperError("permission_denied", "Permission denied creating %s" % path)
    return {"path": path, "created": True}


def op_git_info(args):
    out = {}
    for raw in (args.get("paths") or [])[:60]:
        try:
            out[raw] = git_info(expand_path(raw))
        except HelperError as exc:
            out[raw] = {"error": exc.message}
    return out


def op_containers(args):
    return list_containers(args.get("details") or [])


# -------------------------------------------------------------------- accounts

def auth_env(config_dir):
    env = dict(os.environ)
    if config_dir is None:
        env.pop("CLAUDE_CONFIG_DIR", None)
    else:
        env["CLAUDE_CONFIG_DIR"] = config_dir
    return env


def auth_status_one(claude_path, config_dir):
    if config_dir is not None and not os.path.isdir(config_dir):
        return {"config_dir": config_dir, "exists": False, "state": "missing", "logged_in": False}
    code, out, err = run([claude_path, "auth", "status", "--json"], timeout=30, env=auth_env(config_dir), cwd=home_dir())
    data = None
    text = out.strip()
    if text:
        try:
            data = json.loads(text[text.find("{"):]) if "{" in text else None
        except ValueError:
            data = None
    if isinstance(data, dict) and "loggedIn" in data:
        return {
            "config_dir": config_dir,
            "exists": True,
            "state": "ok",
            "logged_in": bool(data.get("loggedIn")),
            "auth_method": str_or_none(data.get("authMethod"), 40),
            "api_provider": str_or_none(data.get("apiProvider"), 40),
            "email": str_or_none(data.get("email"), 200),
            "org_name": str_or_none(data.get("orgName"), 200),
            "subscription": str_or_none(data.get("subscriptionType"), 40),
        }
    base = config_dir or os.path.join(home_dir(), ".claude")
    return {
        "config_dir": config_dir,
        "exists": True,
        "state": "timeout" if code == 124 else "unsupported",
        "logged_in": None,
        "credentials_file": os.path.exists(os.path.join(base, ".credentials.json")),  # existence only
        "error": redact(first_line(err) or first_line(out))[:200],
    }


def op_auth_status(args):
    claude_path = validate_exe(args.get("claude_path"))
    dirs = args.get("config_dirs")
    if dirs is None:
        dirs = [args.get("config_dir")]
    results = []
    for raw in dirs[:20]:
        results.append(auth_status_one(claude_path, optional_config_dir(raw)))
    return {"results": results}


def op_list_config_dirs(args):
    return {"home": home_dir(), "dirs": list_config_dirs()}


def op_create_config_dir(args):
    path = expand_path(args.get("path"))
    home = home_dir().rstrip("/")
    if os.path.dirname(path) != home:
        raise HelperError("invalid_path", "Config directories must be created directly inside %s" % home)
    if not re.match(r"^\.claude[-_.][A-Za-z0-9][A-Za-z0-9._-]{0,40}$", os.path.basename(path)):
        raise HelperError("invalid_path", "Config directory names must look like ~/.claude-<name>")
    if os.path.lexists(path):
        raise HelperError("exists", "%s already exists" % path)
    os.mkdir(path, 0o700)
    return {"path": path, "created": True}


# ------------------------------------------------------------- runtime control

def build_rc_args(options):
    if not isinstance(options, dict):
        options = {}
    args = []
    name = options.get("name")
    if name:
        args += ["--name", clean_str(name, "name", max_len=120)]
    spawn = options.get("spawn")
    if spawn:
        if spawn not in SPAWN_MODES:
            raise HelperError("invalid_argument", "unsupported spawn mode %r" % spawn)
        args += ["--spawn", spawn]
    mode = options.get("permission_mode")
    if mode:
        if mode not in PERMISSION_MODES:
            raise HelperError("invalid_argument", "unsupported permission mode %r" % mode)
        args += ["--permission-mode", mode]
    if options.get("capacity") is not None:
        args += ["--capacity", str(clamp_int(options.get("capacity"), 1, 256, 32))]
    if options.get("continue"):
        if spawn or options.get("capacity") is not None or options.get("create_session_in_dir") is False:
            raise HelperError("invalid_argument", "--continue cannot be combined with --spawn, --capacity or --no-create-session-in-dir")
        args.append("--continue")
    if options.get("create_session_in_dir") is False:
        args.append("--no-create-session-in-dir")
    if options.get("chrome") is True:
        args.append("--chrome")
    elif options.get("chrome") is False:
        args.append("--no-chrome")
    if options.get("verbose"):
        args.append("--verbose")
    return args


def env_prefix(config_dir, runtime_id=None):
    parts = ["env"]
    if config_dir is None:
        parts += ["-u", "CLAUDE_CONFIG_DIR"]
    else:
        parts.append("CLAUDE_CONFIG_DIR=" + config_dir)
    if runtime_id:
        parts.append("CLAUDE_DECK_RUNTIME_ID=" + runtime_id)
    return parts


def build_pane_argv(shell_mode, shell, config_dir, runtime_id, claude_path, rc_args):
    """argv for the tmux pane. CLAUDE_CONFIG_DIR is scoped to this one process via env(1)."""
    inner = env_prefix(config_dir, runtime_id) + [claude_path, "remote-control"] + rc_args
    if shell_mode == "direct" or os.path.basename(shell) not in POSIX_SHELLS:
        return inner
    flags = "-lic" if shell_mode == "interactive-login" else "-lc"
    # The script is a constant; real arguments arrive as positional parameters, so nothing is re-parsed.
    return [shell, flags, 'exec "$@"', "claude-deck"] + inner


def display_command(config_dir, claude_path, rc_args):
    return " ".join(shlex.quote(p) for p in env_prefix(config_dir) + [claude_path, "remote-control"] + rc_args)


def panes_of_session(session_id):
    return [p for p in list_panes() if p["session_id"] == session_id]


def rc_server_in_pane(procs, claude, root_pid):
    if root_pid not in procs:
        return None
    for pid in [root_pid] + descendants(procs, root_pid):
        if pid in claude and claude[pid][2] in ("rc-server", "interactive-rc"):
            return pid
    return None


def claude_map(procs):
    out = {}
    for pid, proc in procs.items():
        split = claude_argv_split(proc["argv"])
        if split:
            out[pid] = (split[0], split[1], classify_claude(split[1]))
    return out


def op_launch_runtime(args):
    mode = args.get("mode", "new")
    if mode not in ("new", "restart"):
        raise HelperError("invalid_argument", "mode must be new or restart")
    name = validate_managed_name(args.get("session_name"))
    runtime_id = validate_runtime_id(args.get("runtime_id"))
    cwd = expand_path(args.get("cwd"), "cwd")
    if not os.path.isdir(cwd):
        raise HelperError("cwd_missing", "Project folder does not exist: %s" % cwd)
    claude_path = validate_exe(args.get("claude_path"))
    config_dir = optional_config_dir(args.get("config_dir"))
    if config_dir is not None and not os.path.isdir(config_dir):
        raise HelperError("config_missing", "Claude config directory does not exist: %s" % config_dir)
    rc_args = build_rc_args(args.get("options"))
    shell_mode = args.get("shell_mode", "interactive-login")
    if shell_mode not in SHELL_MODES:
        raise HelperError("invalid_argument", "invalid shell mode")
    width = clamp_int(args.get("width"), 80, 1000, 220)
    height = clamp_int(args.get("height"), 20, 200, 50)
    argv = build_pane_argv(shell_mode, login_shell(), config_dir, runtime_id, claude_path, rc_args)
    command = display_command(config_dir, claude_path, rc_args)

    existing = find_session(name)
    if existing is not None:
        if mode != "restart":
            raise HelperError("name_taken", "A tmux session named %s already exists" % name)
        if existing.get("@cdeck_runtime") != runtime_id:
            raise HelperError("not_managed", "tmux session %s was not created by Claude Deck for this runtime" % name)
        panes = sorted(panes_of_session(existing["session_id"]), key=lambda p: (to_int(p["window_index"], 0), to_int(p["pane_index"], 0)))
        if not panes:
            raise HelperError("tmux_error", "tmux session %s has no panes" % name)
        pane = panes[0]
        kill_idle_shell = False
        if pane["pane_dead"] != "1":
            procs = read_proc_table(os.getuid())
            claude = claude_map(procs)
            root = to_int(pane["pane_pid"])
            if rc_server_in_pane(procs, claude, root) is not None:
                raise HelperError("still_running", "Claude Remote Control is still running in %s; stop it first" % name)
            fg = foreground_info(procs, root, claude)
            if fg.get("kind") == "shell-idle" and not fg.get("children"):
                kill_idle_shell = True
            else:
                raise HelperError("pane_busy", "The pane in %s is running %s" % (name, fg.get("comm") or "another program"))
        cmd = ["respawn-pane"] + (["-k"] if kill_idle_shell else []) + ["-t", pane["pane_id"], "-c", tmux_dir(cwd), "--"] + tmux_args(argv)
        code, _out, err = tmux(cmd, timeout=15)
        if code != 0:
            raise HelperError("tmux_error", (err.strip() or "respawn-pane failed")[:400])
        return {
            "session_id": existing["session_id"], "window_id": pane["window_id"], "pane_id": pane["pane_id"],
            "respawned": True, "command": command,
        }

    fmt = SEP.join(["#{session_id}", "#{window_id}", "#{pane_id}", "#{pane_pid}"])
    target = "=%s:" % name
    cmd = ["new-session", "-d", "-P", "-F", fmt, "-s", name, "-c", tmux_dir(cwd), "-x", str(width), "-y", str(height), "--"] + tmux_args(argv)
    cmd += [";", "set-option", "-w", "-t", target, "remain-on-exit", "on"]
    cmd += [";", "set-option", "-t", target, "@cdeck_runtime", runtime_id]
    cmd += [";", "set-option", "-t", target, "@cdeck_managed", "1"]
    code, out, err = tmux(cmd, timeout=15)
    if code != 0:
        raise HelperError("tmux_error", (err.strip() or "new-session failed")[:400])
    parts = out.strip().split("\n")[0].split(SEP)
    if len(parts) != 4:
        raise HelperError("tmux_error", "unexpected tmux output")
    return {
        "session_id": parts[0], "window_id": parts[1], "pane_id": parts[2], "pane_pid": to_int(parts[3]),
        "respawned": False, "command": command,
    }


def wait_exit(pid, start, timeout):
    deadline = time.time() + max(0.0, timeout)
    while time.time() < deadline:
        if not process_alive(pid, start):
            return True
        time.sleep(0.2)
    return not process_alive(pid, start)


def op_stop_runtime(args):
    pane_id = validate_pane_id(args.get("pane_id"))
    mode = args.get("mode", "interrupt")
    if mode not in ("interrupt", "terminate", "kill"):
        raise HelperError("invalid_argument", "mode must be interrupt, terminate or kill")
    wait = clamp_int(args.get("wait_seconds"), 1, 60, 15)
    pane = find_pane(pane_id)
    if pane is None:
        return {"state": "pane_missing"}
    if pane["pane_dead"] == "1":
        return {"state": "not_running", "dead": True, "dead_status": to_int(pane["pane_dead_status"])}
    procs = read_proc_table(os.getuid())
    claude = claude_map(procs)
    root = to_int(pane["pane_pid"])
    server_pid = rc_server_in_pane(procs, claude, root)
    if server_pid is None:
        return {"state": "not_running"}
    expected = to_int(args.get("server_pid"))
    expected_start = args.get("server_start")
    server_start = procs[server_pid]["start"]
    if expected and (expected != server_pid or (expected_start is not None and str(expected_start) != str(server_start))):
        raise HelperError("server_changed", "Remote Control in this pane changed since the last refresh (now pid %s). Refresh and try again." % server_pid)
    note = None
    sessions = [p for p in descendants(procs, server_pid) if p in claude and claude[p][2] == "rc-session"]

    def in_foreground():
        root_stat = read_stat(root)
        server_stat = read_stat(server_pid)
        return bool(root_stat and server_stat) and server_stat[2] == root_stat[3]

    def interrupt():
        # Ctrl+C reaches whatever is in the foreground of the pane, so only use it when that is the
        # Remote Control server; otherwise signal the verified pid directly.
        if in_foreground():
            tmux(["send-keys", "-t", pane_id, "C-c"])
        elif process_alive(server_pid, server_start):
            try:
                os.kill(server_pid, signal.SIGINT)
            except OSError:
                pass

    t0 = time.time()
    if mode == "interrupt":
        interrupt()
        stopped = wait_exit(server_pid, server_start, min(5, wait))
        if not stopped:
            # Some terminal UIs ask for a second Ctrl+C to confirm exiting.
            interrupt()
            stopped = wait_exit(server_pid, server_start, max(1, wait - (time.time() - t0)))
    else:
        sig = signal.SIGTERM if mode == "terminate" else signal.SIGKILL
        for pid in [server_pid] + sessions:
            if process_alive(pid, procs[pid]["start"]):
                try:
                    os.kill(pid, sig)
                except OSError:
                    pass
        stopped = wait_exit(server_pid, server_start, wait)
    remaining = [p for p in sessions if process_alive(p, procs[p]["start"])]
    return {
        "state": "stopped" if stopped else "still_running",
        "pid": server_pid,
        "elapsed_ms": int((time.time() - t0) * 1000),
        "remaining_sessions": len(remaining),
        "note": note,
    }


def op_end_session(args):
    name = clean_str(args.get("session_name"), "session_name", max_len=200)
    runtime_id = args.get("runtime_id")
    allow_unmanaged = bool(args.get("allow_unmanaged"))
    force = bool(args.get("force"))
    sess = find_session(name)
    if sess is None:
        return {"state": "missing"}
    managed = bool(runtime_id) and sess.get("@cdeck_runtime") == runtime_id
    if not managed and not allow_unmanaged:
        raise HelperError("not_managed", "tmux session %s was not created by Claude Deck; confirm explicitly to end it" % name)
    procs = read_proc_table(os.getuid())
    claude = claude_map(procs)
    busy = []
    for pane in panes_of_session(sess["session_id"]):
        if pane["pane_dead"] == "1":
            continue
        root = to_int(pane["pane_pid"])
        if rc_server_in_pane(procs, claude, root) is not None:
            busy.append({"pane_id": pane["pane_id"], "what": "claude remote-control"})
            continue
        fg = foreground_info(procs, root, claude)
        if fg.get("kind") != "shell-idle" or fg.get("children"):
            busy.append({"pane_id": pane["pane_id"], "what": fg.get("comm") or fg.get("kind")})
    if busy and not force:
        return {"state": "busy", "busy": busy, "managed": managed}
    code, _out, err = tmux(["kill-session", "-t", sess["session_id"]])
    if code != 0:
        raise HelperError("tmux_error", (err.strip() or "kill-session failed")[:400])
    return {"state": "ended", "managed": managed}


def op_restart_in_shell(args):
    """For imported sessions: type the Remote Control command into an idle shell prompt."""
    pane_id = validate_pane_id(args.get("pane_id"))
    claude_path = validate_exe(args.get("claude_path"))
    config_dir = optional_config_dir(args.get("config_dir"))
    if config_dir is not None and not os.path.isdir(config_dir):
        raise HelperError("config_missing", "Claude config directory does not exist: %s" % config_dir)
    rc_args = build_rc_args(args.get("options"))
    pane = find_pane(pane_id)
    if pane is None:
        raise HelperError("pane_missing", "tmux pane %s no longer exists" % pane_id)
    if pane["pane_dead"] == "1":
        raise HelperError("pane_dead", "tmux pane %s is dead" % pane_id)
    procs = read_proc_table(os.getuid())
    claude = claude_map(procs)
    root = to_int(pane["pane_pid"])
    if rc_server_in_pane(procs, claude, root) is not None:
        raise HelperError("still_running", "Claude Remote Control is already running in this pane")
    fg = foreground_info(procs, root, claude)
    if fg.get("kind") != "shell-idle" or fg.get("children"):
        raise HelperError("pane_busy", "The pane is not at an idle shell prompt (foreground: %s)" % (fg.get("comm") or fg.get("kind")))
    if procs[root]["comm"].lstrip("-") not in POSIX_SHELLS:
        raise HelperError("unsupported_shell", "Unsupported shell in pane: %s" % procs[root]["comm"])
    # Discard anything half-typed (or an open quote) at the prompt, then require a bare prompt.
    tmux(["send-keys", "-t", pane_id, "C-c"])
    time.sleep(0.4)
    visible = [l for l in sanitize_lines(capture_pane(pane_id) or "", max_lines=12) if l.strip()]
    prompt = visible[-1] if visible else ""
    if not PROMPT_RE.search(prompt):
        raise HelperError("prompt_unclear", "The shell prompt in this pane is not clear (last line: %r). Open the terminal and start Remote Control there." % prompt[-80:])
    procs = read_proc_table(os.getuid())
    if foreground_info(procs, root, claude_map(procs)).get("kind") != "shell-idle":
        raise HelperError("pane_busy", "The pane is no longer at an idle shell prompt")
    # `command` bypasses shell aliases/functions named env.
    line = "command " + display_command(config_dir, claude_path, rc_args)
    code, _out, err = tmux(["send-keys", "-t", pane_id, "-l", tmux_arg(line)])
    if code == 0:
        code, _out, err = tmux(["send-keys", "-t", pane_id, "Enter"])
    if code != 0:
        raise HelperError("tmux_error", (err.strip() or "send-keys failed")[:400])
    return {"command": line, "pane_id": pane_id}


def op_capture(args):
    pane_id = validate_pane_id(args.get("pane_id"))
    lines = clamp_int(args.get("lines"), 10, 2000, 200)
    text = capture_pane(pane_id, history=lines)
    if text is None:
        raise HelperError("pane_missing", "tmux pane %s no longer exists" % pane_id)
    return {"pane_id": pane_id, "lines": sanitize_lines(text, max_lines=lines), "parsed": parse_screen(capture_pane(pane_id) or "", text)}


# ----------------------------------------------------------------------- login

def login_url_ok(url):
    match = re.match(r"^https://([A-Za-z0-9.-]+)(/[^\s]*)?$", url)
    if not match:
        return False
    host = match.group(1).lower()
    path = (match.group(2) or "").lower()
    if host not in LOGIN_URL_HOSTS:
        return False
    return any(key in path for key in ("oauth", "authorize", "login", "device"))


def op_login_start(args):
    name = validate_managed_name(args.get("session_name"))
    if not name.startswith("cdeck-login-"):
        raise HelperError("invalid_argument", "login sessions must be named cdeck-login-*")
    claude_path = validate_exe(args.get("claude_path"))
    config_dir = optional_config_dir(args.get("config_dir"))
    if config_dir is not None and not os.path.isdir(config_dir):
        raise HelperError("config_missing", "Claude config directory does not exist: %s" % config_dir)
    method = args.get("method") or "claudeai"
    if method not in ("claudeai", "console", "sso"):
        raise HelperError("invalid_argument", "invalid login method")
    if find_session(name) is not None:
        raise HelperError("name_taken", "A tmux session named %s already exists" % name)
    inner = env_prefix(config_dir) + [claude_path, "auth", "login"]
    if method == "console":
        inner.append("--console")
    elif method == "sso":
        inner.append("--sso")
    email = args.get("email")
    if email:
        if not isinstance(email, str) or not EMAIL_RE.match(email):
            raise HelperError("invalid_argument", "invalid email address")
        inner += ["--email", email]
    shell = login_shell()
    if os.path.basename(shell) in POSIX_SHELLS:
        argv = [shell, "-lic", 'exec "$@"', "claude-deck"] + inner
    else:
        argv = inner
    target = "=%s:" % name
    fmt = SEP.join(["#{session_id}", "#{window_id}", "#{pane_id}", "#{pane_pid}"])
    cmd = ["new-session", "-d", "-P", "-F", fmt, "-s", name, "-c", tmux_dir(home_dir()), "-x", "600", "-y", "40", "--"] + tmux_args(argv)
    cmd += [";", "set-option", "-w", "-t", target, "remain-on-exit", "on"]
    cmd += [";", "set-option", "-t", target, "@cdeck_login", "1"]
    code, out, err = tmux(cmd, timeout=15)
    if code != 0:
        raise HelperError("tmux_error", (err.strip() or "new-session failed")[:400])
    parts = out.strip().split("\n")[0].split(SEP)
    return {"session_id": parts[0], "pane_id": parts[2] if len(parts) > 2 else None, "session_name": name}


def op_login_poll(args):
    name = validate_managed_name(args.get("session_name"))
    sess = find_session(name)
    if sess is None or sess.get("@cdeck_login") != "1":
        return {"state": "gone"}
    panes = panes_of_session(sess["session_id"])
    if not panes:
        return {"state": "gone"}
    pane = panes[0]
    text = capture_pane(pane["pane_id"], history=300) or ""
    plain = CTRL_RE.sub("", strip_ansi(text))
    urls = []
    for match in re.finditer(r"https://[^\s\"'<>]+", plain):
        url = match.group(0).rstrip(").,;]")
        if login_url_ok(url):
            urls.append(url[:4000])
    success = re.search(r"login successful|logged in as|successfully logged in|you're all set|signed in", plain, re.I) is not None
    awaiting = re.search(r"paste (?:the )?code|enter (?:the )?(?:authorization )?code|code here", plain, re.I) is not None
    dead = pane["pane_dead"] == "1"
    return {
        "state": "exited" if dead else "running",
        "exit_status": to_int(pane["pane_dead_status"]),
        "pane_id": pane["pane_id"],
        "auth_url": urls[-1] if urls else None,
        "success_hint": success,
        "awaiting_code": awaiting and not success,
        "screen_tail": sanitize_lines(text, max_lines=14),
    }


def op_login_cleanup(args):
    name = validate_managed_name(args.get("session_name"))
    if not name.startswith("cdeck-login-"):
        raise HelperError("invalid_argument", "not a login session")
    sess = find_session(name)
    if sess is None:
        return {"state": "missing"}
    if sess.get("@cdeck_login") != "1":
        raise HelperError("not_managed", "refusing to end a session that is not a Claude Deck login session")
    tmux(["kill-session", "-t", sess["session_id"]])
    return {"state": "ended"}


# --------------------------------------------------------------------- dispatch

OPS = {
    "probe": op_probe,
    "snapshot": op_snapshot,
    "list_dir": op_list_dir,
    "check_path": op_check_path,
    "mkdir": op_mkdir,
    "git_info": op_git_info,
    "containers": op_containers,
    "auth_status": op_auth_status,
    "list_config_dirs": op_list_config_dirs,
    "create_config_dir": op_create_config_dir,
    "launch_runtime": op_launch_runtime,
    "stop_runtime": op_stop_runtime,
    "end_session": op_end_session,
    "restart_in_shell": op_restart_in_shell,
    "capture": op_capture,
    "login_start": op_login_start,
    "login_poll": op_login_poll,
    "login_cleanup": op_login_cleanup,
}


def handle(request):
    global TMUX_SOCKET
    t0 = time.time()
    meta = {"helper_version": HELPER_VERSION, "protocol": PROTOCOL}
    if not isinstance(request, dict):
        return dict(meta, ok=False, error={"code": "bad_request", "message": "request must be an object"})
    sock = request.get("tmux_socket")
    if sock is not None:
        if not isinstance(sock, str) or not SOCKET_RE.match(sock):
            return dict(meta, ok=False, error={"code": "bad_request", "message": "invalid tmux_socket"})
        TMUX_SOCKET = sock
    else:
        TMUX_SOCKET = None
    op = request.get("op")
    fn = OPS.get(op)
    if fn is None:
        return dict(meta, ok=False, error={"code": "unknown_op", "message": "unknown operation %r" % (op,)})
    args = request.get("args") or {}
    if not isinstance(args, dict):
        return dict(meta, ok=False, error={"code": "bad_request", "message": "args must be an object"})
    try:
        result = fn(args)
        return dict(meta, ok=True, result=result, elapsed_ms=int((time.time() - t0) * 1000))
    except HelperError as exc:
        return dict(meta, ok=False, error={"code": exc.code, "message": exc.message, "details": exc.details})
    except Exception as exc:  # noqa: BLE001 - report instead of crashing the protocol
        return dict(meta, ok=False, error={
            "code": "internal",
            "message": redact("%s: %s" % (type(exc).__name__, exc))[:500],
            "trace": redact(traceback.format_exc()[-1500:]),
        })


def emit(obj):
    sys.stdout.write(RESULT_MARKER + json.dumps(obj, separators=(",", ":"), ensure_ascii=True) + "\n")
    sys.stdout.flush()


def entry(b64):
    try:
        request = json.loads(base64.b64decode(b64).decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "error": {"code": "bad_request", "message": "could not decode request: %s" % exc}})
        return
    emit(handle(request))


def cli_main(argv):
    op = argv[1]
    args = json.loads(argv[2]) if len(argv) > 2 else {}
    print(json.dumps(handle({"op": op, "args": args}), indent=2, ensure_ascii=False))


if __name__ == "__main__" and len(sys.argv) > 1 and sys.argv[1] != "-":
    cli_main(sys.argv)
