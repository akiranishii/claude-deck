#!/usr/bin/env python3
"""Claude Deck jobs: run and monitor `claude -p` jobs under any of your Claude accounts.

One stdlib-only file with three roles:

  cdeck_jobs.py mcp                  MCP server (stdio) giving a "main" agent tools to start, watch,
                                     collect, cancel and resume jobs on any account.
  cdeck_jobs.py daemon               Scheduler: queues jobs, runs up to N per account, pauses an
                                     account until its rate-limit window resets, retries, times out.
                                     Started automatically when needed; exits when idle.
  cdeck_jobs.py <tool> '<json>'|@file|-   The same tools from a shell (prints JSON), e.g.
                                     cdeck_jobs.py status '{"tag": "batch1"}'
  cdeck_jobs.py init                 Write a config listing the signed-in accounts (never overwrites).

State lives in ~/.claude-deck/jobs (override with CDECK_JOBS_HOME): config.json, jobs.db (SQLite)
and runs/<job>/ (prompt, stream-json events, stderr). Each job is
    env [-u CLAUDE_CONFIG_DIR | CLAUDE_CONFIG_DIR=<account dir>] claude -p --output-format stream-json ...
with the prompt on stdin and arguments passed as a list (no shell). Jobs keep running if the MCP
client or the daemon goes away; a restarted daemon picks them up again. No network ports are opened.
Claude credentials are never read: accounts are just config directories.
"""

import fcntl
import json
import os
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

VERSION = "1.0.0"
HOME = os.path.expanduser("~")
BASE = os.path.abspath(os.path.expanduser(os.environ.get("CDECK_JOBS_HOME", "~/.claude-deck/jobs")))
CONFIG_PATH = os.path.join(BASE, "config.json")
DB_PATH = os.path.join(BASE, "jobs.db")
RUNS = os.path.join(BASE, "runs")
LOCK_PATH = os.path.join(BASE, "daemon.lock")
DAEMON_LOG = os.path.join(BASE, "daemon.log")

TERMINAL = ("done", "failed", "cancelled")
STATES = ("queued", "running") + TERMINAL
EFFORTS = ("low", "medium", "high", "xhigh", "max")
PERMISSION_MODES = ("default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions")
# Flags the caller may not pass through extra_args: they are owned by the runner (or need config).
RESERVED_FLAGS = ("-p", "--print", "--output-format", "--input-format", "--verbose", "--permission-mode",
                  "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--resume", "-r",
                  "--continue", "-c", "--session-id")
ACCOUNT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$")
TAG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,80}$")

DEFAULT_CONFIG = {
    "claude_path": None,               # null: ~/.npm-global/bin/claude, ~/.local/bin/claude, then PATH
    "default_max_parallel": 2,         # concurrent jobs per account unless the account says otherwise
    "default_timeout_s": 3600,
    "default_max_attempts": 2,         # for transient failures (API overload, crashes); rate limits don't count
    "allow_bypass_permissions": False, # permission_mode "bypassPermissions" is refused unless set to true
    "idle_exit_minutes": 20,           # the daemon exits after this long with nothing queued or running
    # A job interrupted by a usage limit waits to continue its conversation on the same account. If that account is
    # paused for longer than this (e.g. a weekly limit), restart the job on another account instead, telling it to
    # review and finish the partial work already in its folder. 0 disables.
    "reroute_after_hours": 5.5,
    "login_shell_env": True,           # give jobs your login shell's PATH etc. (captured once per daemon)
    # Extra environment for every job. By default `claude -p` stops background sub-agents 10 minutes after
    # the main agent's last turn; jobs have their own timeout, so let them finish.
    "job_env": {"CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS": "0"},
    # Extra environment for every job. By default `claude -p` stops background sub-agents 10 minutes after
    # the main agent's last turn; jobs have their own timeout, so let them finish.
    "job_env": {"CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS": "0"},
    "accounts": {},                    # name -> {"config_dir": null | "~/.claude-x", "max_parallel": n, "enabled": true}
}


class ToolError(Exception):
    def __init__(self, code, message):
        Exception.__init__(self, message)
        self.code = code
        self.message = message


def now():
    return time.time()


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)) if ts else None


def ensure_base():
    os.makedirs(RUNS, mode=0o700, exist_ok=True)
    os.chmod(BASE, 0o700)


# ------------------------------------------------------------------------------------------ config

def load_config():
    cfg = dict(DEFAULT_CONFIG)
    try:
        with open(CONFIG_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict):
            cfg.update(data)
    except FileNotFoundError:
        pass
    except ValueError as e:
        raise ToolError("bad_config", "%s is not valid JSON: %s" % (CONFIG_PATH, e))
    accounts = {}
    for name, acc in (cfg.get("accounts") or {}).items():
        if not ACCOUNT_RE.match(str(name)) or name == "any":
            continue
        acc = acc if isinstance(acc, dict) else {}
        raw_dir = acc.get("config_dir")
        accounts[name] = {
            "config_dir": os.path.abspath(os.path.expanduser(raw_dir)) if raw_dir else None,
            "max_parallel": max(0, int(acc.get("max_parallel", cfg["default_max_parallel"]))),
            "enabled": bool(acc.get("enabled", True)),
            "keep_api_key_env": bool(acc.get("keep_api_key_env", False)),
        }
    cfg["accounts"] = accounts
    return cfg


def claude_path(cfg):
    candidates = [cfg.get("claude_path"), "~/.npm-global/bin/claude", "~/.local/bin/claude", "~/.claude/local/claude"]
    for c in candidates:
        if c:
            p = os.path.expanduser(c)
            if os.path.isfile(p) and os.access(p, os.X_OK):
                return p
    for d in os.environ.get("PATH", "").split(":"):
        p = os.path.join(d, "claude")
        if d and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    raise ToolError("claude_missing", "claude was not found; set claude_path in %s" % CONFIG_PATH)


def auth_env(config_dir):
    env = dict(os.environ)
    env.pop("CLAUDE_CONFIG_DIR", None)
    if config_dir:
        env["CLAUDE_CONFIG_DIR"] = config_dir
    return env


def auth_status(cfg, config_dir):
    """Ask claude itself whether this config dir is signed in (credentials are never read)."""
    if config_dir and not os.path.isdir(config_dir):
        return {"logged_in": False, "error": "config dir missing"}
    try:
        p = subprocess.run([claude_path(cfg), "auth", "status", "--json"], env=auth_env(config_dir), cwd=HOME,
                           stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)
        text = p.stdout.strip()
        data = json.loads(text[text.find("{"):]) if "{" in text else {}
        return {"logged_in": bool(data.get("loggedIn")), "email": data.get("email"),
                "subscription": data.get("subscriptionType"), "auth_method": data.get("authMethod")}
    except (subprocess.TimeoutExpired, ValueError, OSError) as e:
        return {"logged_in": None, "error": str(e)[:200]}


def cmd_init(argv):
    """Discover signed-in accounts (~/.claude and ~/.claude-*) and write config.json if missing."""
    ensure_base()
    if os.path.exists(CONFIG_PATH) and "--force" not in argv:
        print(json.dumps({"config": CONFIG_PATH, "written": False, "note": "config exists; edit it or pass --force"}, indent=2))
        return 0
    cfg = dict(DEFAULT_CONFIG)
    accounts = {}
    candidates = [("main", None)]
    for entry in sorted(os.listdir(HOME)):
        m = re.match(r"^\.claude[-_.]([A-Za-z0-9][A-Za-z0-9._-]{0,40})$", entry)
        if m and entry != os.path.basename(os.path.dirname(BASE)) and entry != ".claude-deck" \
                and os.path.isdir(os.path.join(HOME, entry)):
            candidates.append((m.group(1), os.path.join(HOME, entry)))
    report = []
    for name, d in candidates:
        st = auth_status(load_config(), d)
        report.append({"account": name, "config_dir": d, **st})
        if st.get("logged_in"):
            accounts[name] = {"config_dir": ("~/" + os.path.relpath(d, HOME)) if d else None,
                              "max_parallel": cfg["default_max_parallel"], "enabled": True}
    cfg["accounts"] = accounts
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG_PATH)
    print(json.dumps({"config": CONFIG_PATH, "written": True, "accounts": list(accounts), "checked": report}, indent=2))
    return 0


# ---------------------------------------------------------------------------------------- database

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  created_at REAL NOT NULL,
  tag TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  account_req TEXT NOT NULL,
  account TEXT,
  cwd TEXT NOT NULL,
  prompt TEXT NOT NULL,
  options TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  timeout_s INTEGER NOT NULL,
  not_before REAL NOT NULL DEFAULT 0,
  pid INTEGER,
  pid_start TEXT,
  started_at REAL,
  finished_at REAL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  error TEXT,
  result TEXT,
  structured TEXT,
  session_id TEXT,
  cost_usd REAL,
  num_turns INTEGER,
  duration_ms INTEGER,
  collected INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT
);
CREATE INDEX IF NOT EXISTS jobs_queue ON jobs(state, account_req, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_tag ON jobs(tag, state);
CREATE TABLE IF NOT EXISTS accounts (
  name TEXT PRIMARY KEY,
  paused_until REAL NOT NULL DEFAULT 0,
  pause_reason TEXT,
  manual_pause INTEGER NOT NULL DEFAULT 0,
  max_parallel INTEGER,
  rate_limit TEXT,
  updated_at REAL
);
"""


_local = threading.local()


def db():
    """One connection per thread (tool calls close theirs when done)."""
    conn = getattr(_local, "conn", None)
    if conn is not None and getattr(_local, "path", None) == DB_PATH:
        return conn
    ensure_base()
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.executescript(SCHEMA)
    try:
        os.chmod(DB_PATH, 0o600)
    except OSError:
        pass
    _local.conn, _local.path = conn, DB_PATH
    return conn


def close_db():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


class Tx:
    """BEGIN IMMEDIATE ... COMMIT, so the daemon and tool callers never interleave a state change."""

    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb):
        self.conn.execute("ROLLBACK" if exc_type else "COMMIT")
        return False


def account_state(conn, name):
    row = conn.execute("SELECT * FROM accounts WHERE name=?", (name,)).fetchone()
    return dict(row) if row else {"name": name, "paused_until": 0, "pause_reason": None, "manual_pause": 0,
                                  "max_parallel": None, "rate_limit": None}


def upsert_account(conn, name, **fields):
    fields["updated_at"] = now()
    conn.execute("INSERT OR IGNORE INTO accounts(name) VALUES (?)", (name,))
    sets = ", ".join("%s=?" % k for k in fields)
    conn.execute("UPDATE accounts SET %s WHERE name=?" % sets, list(fields.values()) + [name])


# --------------------------------------------------------------------------------------- processes

def proc_start(pid):
    """Process start time, to make sure a stored pid still is our job and not a reused pid."""
    try:
        with open("/proc/%d/stat" % pid) as f:
            data = f.read()
        return data[data.rfind(")") + 2:].split()[19]
    except (OSError, IndexError):
        pass
    try:
        out = subprocess.run(["ps", "-o", "lstart=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout.strip()
        return out or None
    except (OSError, subprocess.SubprocessError):
        return None


def alive(pid, start):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return False
    cur = proc_start(pid)
    return cur is not None and (start is None or cur == start)


def kill_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except (ProcessLookupError, PermissionError):
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


_login_env = None


def login_env(cfg):
    """Your login shell's environment (PATH, tool versions…), captured once; CLAUDE_CONFIG_DIR is set per job."""
    global _login_env
    if _login_env is None:
        env = dict(os.environ)
        if cfg.get("login_shell_env", True):
            shell = os.environ.get("SHELL") or "/bin/bash"
            try:
                marker = b"\0__CDECK_ENV__\0"
                out = subprocess.run([shell, "-lic", "printf '\\0__CDECK_ENV__\\0'; env -0"], stdin=subprocess.DEVNULL,
                                     capture_output=True, timeout=15, cwd=HOME).stdout
                out = out.split(marker, 1)[1] if marker in out else b""  # ignore anything the rc files print
                parsed = {}
                for item in out.split(b"\0"):
                    if b"=" in item:
                        k, v = item.split(b"=", 1)
                        parsed[k.decode("utf-8", "replace")] = v.decode("utf-8", "replace")
                if parsed.get("PATH"):
                    env = parsed
            except (OSError, subprocess.SubprocessError):
                pass
        for k in ("PS1", "SHLVL", "OLDPWD", "_", "TMUX", "TMUX_PANE"):
            env.pop(k, None)
        _login_env = env
    return dict(_login_env)


def job_env(cfg, acc):
    env = login_env(cfg)
    env.pop("CLAUDE_CONFIG_DIR", None)
    if acc["config_dir"]:
        env["CLAUDE_CONFIG_DIR"] = acc["config_dir"]
    if not acc.get("keep_api_key_env"):
        # An API key in the environment would bill that key instead of the account's subscription.
        env.pop("ANTHROPIC_API_KEY", None)
        env.pop("ANTHROPIC_AUTH_TOKEN", None)
    for k, v in (cfg.get("job_env") or {}).items():
        if isinstance(k, str) and k != "CLAUDE_CONFIG_DIR":
            env[k] = str(v)
    for k, v in (cfg.get("job_env") or {}).items():
        if isinstance(k, str) and k != "CLAUDE_CONFIG_DIR":
            env[k] = str(v)
    env["CLAUDE_DECK_JOB"] = "1"
    return env


def build_argv(cfg, options):
    o = options or {}
    argv = [claude_path(cfg), "-p", "--output-format", "stream-json", "--verbose"]
    mode = o.get("permission_mode")
    if mode:
        argv += ["--permission-mode", mode]
    if o.get("resume_session"):
        argv += ["--resume", o["resume_session"]]
    if o.get("effort"):
        argv += ["--effort", o["effort"]]
    for key, flag in (("model", "--model"), ("fallback_model", "--fallback-model"),
                      ("append_system_prompt", "--append-system-prompt"), ("system_prompt", "--system-prompt")):
        if o.get(key):
            argv += [flag, str(o[key])]
    if o.get("max_turns"):
        argv += ["--max-turns", str(int(o["max_turns"]))]
    if o.get("max_budget_usd"):
        argv += ["--max-budget-usd", str(float(o["max_budget_usd"]))]
    if o.get("json_schema"):
        schema = o["json_schema"]
        argv += ["--json-schema", schema if isinstance(schema, str) else json.dumps(schema)]
    for d in o.get("add_dirs") or []:
        argv += ["--add-dir", os.path.expanduser(str(d))]
    if o.get("mcp_config"):
        argv += ["--mcp-config", str(o["mcp_config"])]
    if o.get("strict_mcp_config"):
        argv += ["--strict-mcp-config"]
    if o.get("no_session_persistence"):
        argv += ["--no-session-persistence"]
    if o.get("allowed_tools"):
        argv += ["--allowedTools"] + [str(t) for t in o["allowed_tools"]]
    if o.get("disallowed_tools"):
        argv += ["--disallowedTools"] + [str(t) for t in o["disallowed_tools"]]
    argv += [str(a) for a in (o.get("extra_args") or [])]
    return argv


# ----------------------------------------------------------------------------------- run outcomes

REROUTE_NOTE = (
    "NOTE: a previous run of this job was interrupted by a usage limit on another account. Its working folder may already "
    "contain partial work: review it, verify it rather than trusting it, redo anything incomplete or doubtful, and complete "
    "everything the instructions below require.\n\n")
CONTINUE_AFTER_LIMIT = (
    "You were interrupted by a usage limit before you finished. The limit has reset. Continue the same task from where "
    "you left off, using the work already done in this conversation and on disk. Redo any sub-agent or tool work whose "
    "results were lost, and complete everything the original instructions require.")
LIMIT_RE = re.compile(r"usage limit|limit reached|rate.?limit|too many requests|\b429\b|out of (extra )?usage", re.I)
OVERLOAD_RE = re.compile(r"overloaded|\b5\d\d\b|internal server error|ECONNRESET|ETIMEDOUT|socket hang up|network", re.I)
BG_STOPPED_RE = re.compile(r"Background tasks still running[^\n]*stopping them", re.I)
BG_STOPPED_RE = re.compile(r"Background tasks still running[^\n]*stopping them", re.I)
AUTH_RE = re.compile(r"not logged in|please run /login|invalid api key|authentication|oauth token|unauthorized|\b401\b", re.I)


def read_events(path, limit_bytes=None):
    events = []
    try:
        with open(path, "rb") as f:
            if limit_bytes:
                f.seek(0, 2)
                size = f.tell()
                f.seek(max(0, size - limit_bytes))
                if size > limit_bytes:
                    f.readline()
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if isinstance(ev, dict):
                    events.append(ev)
    except FileNotFoundError:
        pass
    return events


def tail_text(path, n=2000):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - n))
            return f.read().decode("utf-8", "replace").strip()
    except OSError:
        return ""


def classify(job_dir, exit_code, timed_out):
    """Work out what happened from the stream-json events. Returns an outcome dict."""
    events = read_events(os.path.join(job_dir, "events.jsonl"), limit_bytes=4 * 1024 * 1024)
    result = None
    rate = None
    session_id = None
    for ev in events:
        t = ev.get("type")
        if t == "result":
            result = ev
        elif t == "rate_limit_event" and isinstance(ev.get("rate_limit_info"), dict):
            rate = ev["rate_limit_info"]
        elif t == "system" and ev.get("subtype") == "init":
            session_id = ev.get("session_id") or session_id
    stderr = tail_text(os.path.join(job_dir, "stderr.log"))
    out = {"rate": rate, "session_id": (result or {}).get("session_id") or session_id, "result": None,
           "structured": None, "cost_usd": None, "num_turns": None, "duration_ms": None}
    if result:
        out.update(result=result.get("result"), cost_usd=result.get("total_cost_usd"), num_turns=result.get("num_turns"),
                   duration_ms=result.get("duration_ms"), structured=result.get("structured_output"))
    rejected = bool(rate and str(rate.get("status", "")).lower() == "rejected")
    if timed_out:
        out.update(kind="failed", error="timed out")
        return out
    stopped = BG_STOPPED_RE.search(stderr)
    if stopped:
        # Claude ended its turn while sub-agents were still working and then stopped them: the
        # "success" result may be only an interim message, so don't call the job done.
        out.update(kind="failed", error="incomplete: background sub-agents were stopped (%s)" % stopped.group(0)[:200])
        return out
    if BG_STOPPED_RE.search(stderr):
        # Claude ended its turn while sub-agents were still working and then stopped them: the
        # "success" result is only an interim message, so the job is not done.
        out.update(kind="failed", error="incomplete: background sub-agents were stopped before the job finished (%s)"
                   % BG_STOPPED_RE.search(stderr).group(0)[:200])
        return out
    if result and not result.get("is_error") and result.get("subtype") == "success":
        out["kind"] = "done"
        return out
    text = " ".join(str(x) for x in ((result or {}).get("result"), (result or {}).get("api_error_status"), stderr) if x)
    status = (result or {}).get("api_error_status")
    if rejected or status == 429 or LIMIT_RE.search(text):
        out.update(kind="rate_limited", error=("rate limited: " + (text[:300] or "limit reached")))
    elif status in (500, 502, 503, 504, 529) or (not result and OVERLOAD_RE.search(text)):
        out.update(kind="transient", error=text[:500] or "API error")
    elif AUTH_RE.search(text) and (not result or result.get("is_error")):
        out.update(kind="auth", error=text[:500])
    elif result:
        sub = result.get("subtype") or "error"
        out.update(kind="failed", error="%s: %s" % (sub, str(result.get("result") or "")[:500]))
    else:
        # No result at all (crash, kill, lost process): worth another attempt.
        out.update(kind="transient", error=(stderr[-500:] or "claude exited with code %s and no result" % exit_code))
    return out


# ------------------------------------------------------------------------------------------ daemon

class Daemon:
    def __init__(self):
        self.cfg = load_config()
        self.conn = db()
        self.procs = {}  # job id -> Popen (jobs started by this daemon)
        self.idle_since = now()
        self.stopping = False

    def log(self, msg, **kw):
        line = "%s %s %s\n" % (iso(now()), msg, json.dumps(kw) if kw else "")
        sys.stderr.write(line)
        sys.stderr.flush()

    def capacity(self, name, acc):
        st = account_state(self.conn, name)
        limit = st["max_parallel"] if st["max_parallel"] is not None else acc["max_parallel"]
        if not acc["enabled"] or st["manual_pause"] or st["paused_until"] > now():
            return 0
        running = self.conn.execute("SELECT COUNT(*) FROM jobs WHERE state='running' AND account=?", (name,)).fetchone()[0]
        return max(0, limit - running)

    def run(self):
        signal.signal(signal.SIGTERM, lambda *a: setattr(self, "stopping", True))
        self.log("daemon started", version=VERSION, pid=os.getpid())
        self.adopt()
        while not self.stopping:
            try:
                self.cfg = load_config()
            except ToolError as e:
                self.log("config error", error=e.message)
            self.reap()
            self.enforce()
            self.reroute_stranded()
            self.schedule()
            busy = self.conn.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0]
            if busy:
                self.idle_since = now()
            elif now() - self.idle_since > float(self.cfg.get("idle_exit_minutes", 20)) * 60:
                self.log("idle, exiting")
                break
            time.sleep(0.5)
        self.log("daemon stopped (running jobs keep going and are picked up by the next daemon)")

    def adopt(self):
        """Jobs left running by a previous daemon: keep watching live ones, requeue lost ones."""
        for row in self.conn.execute("SELECT id, pid, pid_start FROM jobs WHERE state='running'").fetchall():
            if not alive(row["pid"], row["pid_start"]):
                self.finish(row["id"], exit_code=None, timed_out=False)

    def reap(self):
        for row in self.conn.execute("SELECT id, pid, pid_start FROM jobs WHERE state='running'").fetchall():
            p = self.procs.get(row["id"])
            if p is not None:
                code = p.poll()
                if code is None:
                    continue
                self.procs.pop(row["id"], None)
                self.finish(row["id"], exit_code=code, timed_out=False)
            elif not alive(row["pid"], row["pid_start"]):
                self.finish(row["id"], exit_code=None, timed_out=False)

    def enforce(self):
        t = now()
        rows = self.conn.execute("SELECT id, pid, started_at, timeout_s, cancel_requested FROM jobs WHERE state='running'").fetchall()
        for row in rows:
            timed_out = row["timeout_s"] and t - (row["started_at"] or t) > row["timeout_s"]
            if row["cancel_requested"] or timed_out:
                self.stop_proc(row["id"], row["pid"])
                code = self.procs.pop(row["id"]).poll() if row["id"] in self.procs else None
                if row["cancel_requested"]:
                    with Tx(self.conn) as c:
                        c.execute("UPDATE jobs SET state='cancelled', finished_at=?, error='cancelled', pid=NULL WHERE id=?",
                                  (now(), row["id"]))
                    self.log("cancelled", job=row["id"])
                else:
                    self.finish(row["id"], exit_code=code, timed_out=True)
        with Tx(self.conn) as c:
            c.execute("UPDATE jobs SET state='cancelled', finished_at=?, error='cancelled' WHERE state='queued' AND cancel_requested=1",
                      (now(),))

    def stop_proc(self, job_id, pid):
        p = self.procs.get(job_id)
        if not pid:
            return
        kill_group(pid, signal.SIGINT)  # like Ctrl+C: claude exits cleanly
        deadline = now() + 5
        while now() < deadline:
            if (p.poll() is not None) if p else not alive(pid, None):
                return
            time.sleep(0.1)
        kill_group(pid, signal.SIGTERM)
        deadline = now() + 3
        while now() < deadline:
            if (p.poll() is not None) if p else not alive(pid, None):
                return
            time.sleep(0.1)
        kill_group(pid, signal.SIGKILL)
        if p:
            p.wait(timeout=5)

    def finish(self, job_id, exit_code, timed_out):
        job = self.conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not job or job["state"] != "running":
            return
        jd = os.path.join(RUNS, job_id)
        o = classify(jd, exit_code, timed_out)
        acc_name = job["account"]
        t = now()
        with Tx(self.conn) as c:
            if o.get("rate"):
                upsert_account(c, acc_name, rate_limit=json.dumps(o["rate"]))
            common = dict(exit_code=exit_code, session_id=o["session_id"], cost_usd=o["cost_usd"], num_turns=o["num_turns"],
                          duration_ms=o["duration_ms"], result=o["result"],
                          structured=json.dumps(o["structured"]) if o["structured"] is not None else None, pid=None)
            kind = o["kind"]
            if kind == "done":
                self.update(c, job_id, state="done", finished_at=t, error=None, **common)
            elif kind == "rate_limited":
                reset = None
                if o.get("rate"):
                    try:
                        reset = float(o["rate"].get("resetsAt") or 0) or None
                    except (TypeError, ValueError):
                        reset = None
                # Pause until Claude's own reset time; if it gave none (or a past one), back off a while.
                until = reset + 5 if reset and reset > t else t + (60 if reset else 15 * 60)
                upsert_account(c, acc_name, paused_until=until, pause_reason="rate limit until %s" % iso(until))
                # Requeue: rate limits are not the job's fault and don't use up attempts. If the conversation
                # was saved, continue it (with its full context) on the same account once the limit resets,
                # instead of starting over; a conversation can only be resumed on the account that holds it.
                opts = json.loads(job["options"])
                extra = {}
                if o["session_id"] and not opts.get("no_session_persistence"):
                    opts["resume_session"] = o["session_id"]
                    opts["_continue_after_limit"] = True
                    opts.setdefault("_pinned_from", job["account_req"])
                    extra = dict(options=json.dumps(opts), account_req=acc_name)
                self.update(c, job_id, state="queued", account=acc_name if extra or job["account_req"] != "any" else None,
                            started_at=None, not_before=t + 5, error=o["error"], **dict(common, **extra))
                self.log("rate limited; account paused", job=job_id, account=acc_name, until=iso(until))
                return
            elif kind in ("transient", "auth") and job["attempts"] < job["max_attempts"]:
                if kind == "auth":
                    upsert_account(c, acc_name, paused_until=t + 30 * 60, pause_reason="not signed in? " + (o["error"] or "")[:200])
                backoff = min(600, 30 * (2 ** max(0, job["attempts"] - 1)))
                self.update(c, job_id, state="queued", account=None if job["account_req"] == "any" else acc_name,
                            started_at=None, not_before=t + backoff, error=o["error"], **common)
                self.log("retrying", job=job_id, kind=kind, backoff=backoff)
                return
            else:
                if kind == "auth":
                    upsert_account(c, acc_name, paused_until=t + 30 * 60, pause_reason="not signed in? " + (o["error"] or "")[:200])
                self.update(c, job_id, state="failed", finished_at=t, error=o["error"], **common)
        self.log("finished", job=job_id, state=kind, account=acc_name)

    @staticmethod
    def update(c, job_id, **fields):
        sets = ", ".join("%s=?" % k for k in fields)
        c.execute("UPDATE jobs SET %s WHERE id=?" % sets, list(fields.values()) + [job_id])

    def reroute_stranded(self):
        """Move rate-limited continuations off accounts that stay paused for a long time (e.g. weekly limits)."""
        hours = float(self.cfg.get("reroute_after_hours", 5.5) or 0)
        if hours <= 0:
            return
        t = now()
        rows = self.conn.execute("SELECT id, account_req, options, prompt FROM jobs WHERE state='queued' AND account_req != 'any' "
                                 "AND cancel_requested=0 AND options LIKE '%_continue_after_limit%'").fetchall()
        for row in rows:
            o = json.loads(row["options"])
            # Only jobs that could have run anywhere; a job you pinned to an account stays there.
            if not o.get("_continue_after_limit") or o.get("_pinned_from", "any") != "any":
                continue
            st = account_state(self.conn, row["account_req"])
            if st["paused_until"] - t < hours * 3600:
                continue
            if not any(n != row["account_req"] and a["enabled"] for n, a in self.cfg["accounts"].items()):
                continue
            for k in ("resume_session", "_continue_after_limit", "_pinned_from"):
                o.pop(k, None)
            prompt = row["prompt"] if row["prompt"].startswith(REROUTE_NOTE) else REROUTE_NOTE + row["prompt"]
            with Tx(self.conn) as c:
                c.execute("UPDATE jobs SET account_req='any', account=NULL, options=?, prompt=?, not_before=0 "
                          "WHERE id=? AND state='queued'", (json.dumps(o), prompt, row["id"]))
            self.log("rerouted", job=row["id"], from_account=row["account_req"], account_paused_until=iso(st["paused_until"]))

    def schedule(self):
        accounts = self.cfg["accounts"]
        if not accounts:
            return
        t = now()
        free = {name: self.capacity(name, acc) for name, acc in accounts.items()}
        # Jobs pinned to an account.
        for name, slots in free.items():
            if slots <= 0:
                continue
            rows = self.conn.execute(
                "SELECT id FROM jobs WHERE state='queued' AND cancel_requested=0 AND account_req=? AND not_before<=? "
                "ORDER BY priority DESC, created_at LIMIT ?", (name, t, slots)).fetchall()
            for row in rows:
                if self.start(row["id"], name):
                    free[name] -= 1
        # Jobs for any account: fill the account with the most free slots first.
        while True:
            name = max(free, key=lambda n: free[n])
            if free[name] <= 0:
                break
            row = self.conn.execute(
                "SELECT id FROM jobs WHERE state='queued' AND cancel_requested=0 AND account_req='any' AND not_before<=? "
                "ORDER BY priority DESC, created_at LIMIT 1", (t,)).fetchone()
            if not row:
                break
            if self.start(row["id"], name):
                free[name] -= 1
            else:
                free[name] = 0

    def start(self, job_id, acc_name):
        acc = self.cfg["accounts"][acc_name]
        job = self.conn.execute("SELECT * FROM jobs WHERE id=? AND state='queued' AND cancel_requested=0", (job_id,)).fetchone()
        if not job:
            return False
        attempt = job["attempts"] + 1
        jd = os.path.join(RUNS, job_id)
        os.makedirs(jd, mode=0o700, exist_ok=True)
        try:
            options = json.loads(job["options"])
            if not os.path.isdir(job["cwd"]):
                raise ToolError("cwd_missing", "working directory does not exist: %s" % job["cwd"])
            argv = build_argv(self.cfg, options)
            prompt_path = os.path.join(jd, "prompt.txt")
            with open(prompt_path, "w") as f:
                f.write(CONTINUE_AFTER_LIMIT if options.get("_continue_after_limit") else job["prompt"])
            # Each attempt gets a fresh event log; earlier attempts are kept for debugging.
            for name in ("events.jsonl", "stderr.log"):
                path = os.path.join(jd, name)
                if os.path.exists(path):
                    os.replace(path, path + ".attempt%d" % job["attempts"])
            with open(prompt_path, "rb") as stdin, open(os.path.join(jd, "events.jsonl"), "wb") as out, \
                    open(os.path.join(jd, "stderr.log"), "wb") as err:
                p = subprocess.Popen(argv, cwd=job["cwd"], env=job_env(self.cfg, acc), stdin=stdin, stdout=out,
                                     stderr=err, start_new_session=True, close_fds=True)
        except (ToolError, OSError, ValueError) as e:
            msg = e.message if isinstance(e, ToolError) else str(e)
            with Tx(self.conn) as c:
                self.update(c, job_id, state="failed", account=acc_name, attempts=attempt, finished_at=now(), error=msg[:500])
            self.log("could not start", job=job_id, error=msg[:200])
            return True
        # The job becomes "running" together with its pid, so nobody ever sees a running job without one.
        with Tx(self.conn) as c:
            claimed = c.execute(
                "UPDATE jobs SET state='running', account=?, started_at=?, attempts=?, pid=?, pid_start=? "
                "WHERE id=? AND state='queued' AND cancel_requested=0",
                (acc_name, now(), attempt, p.pid, proc_start(p.pid), job_id)).rowcount
        if not claimed:  # cancelled while starting
            kill_group(p.pid, signal.SIGTERM)
            p.wait(timeout=10)
            return False
        self.procs[job_id] = p
        self.log("started", job=job_id, account=acc_name, pid=p.pid)
        return True


def cmd_daemon(argv):
    ensure_base()
    lock = open(LOCK_PATH, "a+")
    # daemon_running() probes take this lock for an instant; retry briefly so a probe that happens to
    # coincide with our start doesn't make us give up. A real daemon holds it for good.
    deadline = time.time() + 3
    while True:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            break
        except OSError:
            if time.time() > deadline:
                return 0  # another daemon is running
            time.sleep(0.05)
    lock.seek(0)
    lock.truncate()
    lock.write(str(os.getpid()))
    lock.flush()
    Daemon().run()
    return 0


def daemon_running():
    ensure_base()
    with open(LOCK_PATH, "a+") as f:
        try:
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.flock(f, fcntl.LOCK_UN)
        return False


def ensure_daemon():
    if daemon_running():
        return
    log = open(DAEMON_LOG, "ab")
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "daemon"], stdin=subprocess.DEVNULL, stdout=log,
                     stderr=log, start_new_session=True, close_fds=True, cwd=HOME)
    log.close()
    for _ in range(50):
        if daemon_running():
            return
        time.sleep(0.05)


# ------------------------------------------------------------------------------------------- tools

def _str(v, name, max_len=None, required=False):
    if v is None:
        if required:
            raise ToolError("invalid_argument", "%s is required" % name)
        return None
    if not isinstance(v, str):
        raise ToolError("invalid_argument", "%s must be a string" % name)
    if max_len and len(v) > max_len:
        raise ToolError("invalid_argument", "%s is too long (max %d characters)" % (name, max_len))
    return v


def validate_options(cfg, options):
    o = dict(options or {})
    known = {"model", "effort", "fallback_model", "permission_mode", "allowed_tools", "disallowed_tools", "max_turns",
             "max_budget_usd", "append_system_prompt", "system_prompt", "json_schema", "add_dirs", "mcp_config",
             "strict_mcp_config", "no_session_persistence", "timeout_s", "max_attempts", "extra_args", "resume_session"}
    unknown = sorted(set(o) - known)
    if unknown:
        raise ToolError("invalid_argument", "unknown option(s): %s" % ", ".join(unknown))
    if o.get("effort") is not None and o["effort"] not in EFFORTS:
        raise ToolError("invalid_argument", "effort must be one of %s" % ", ".join(EFFORTS))
    mode = o.get("permission_mode")
    if mode is not None and mode not in PERMISSION_MODES:
        raise ToolError("invalid_argument", "permission_mode must be one of %s" % ", ".join(PERMISSION_MODES))
    if mode == "bypassPermissions" and not cfg.get("allow_bypass_permissions"):
        raise ToolError("bypass_disabled", "bypassPermissions is disabled. Set \"allow_bypass_permissions\": true in %s "
                        "to allow it, or use acceptEdits plus allowed_tools." % CONFIG_PATH)
    for key in ("allowed_tools", "disallowed_tools", "add_dirs", "extra_args"):
        if key in o and (not isinstance(o[key], list) or not all(isinstance(x, str) for x in o[key])):
            raise ToolError("invalid_argument", "%s must be a list of strings" % key)
    for a in o.get("extra_args") or []:
        flag = a.split("=", 1)[0]
        if flag in RESERVED_FLAGS:
            raise ToolError("invalid_argument", "%s is managed by the job runner; use the matching option instead" % flag)
    for key in ("max_turns", "timeout_s", "max_attempts"):
        if key in o and (not isinstance(o[key], int) or isinstance(o[key], bool) or o[key] < 1):
            raise ToolError("invalid_argument", "%s must be a positive integer" % key)
    return o


def make_job(conn, cfg, spec, defaults=None):
    spec = dict(spec or {})
    merged_opts = dict((defaults or {}).get("options") or {})
    merged_opts.update(spec.get("options") or {})
    for k in ("account", "cwd", "tag", "priority"):
        if spec.get(k) is None and defaults and defaults.get(k) is not None:
            spec[k] = defaults[k]
    prompt = _str(spec.get("prompt"), "prompt", max_len=1_000_000, required=True)
    if not prompt.strip():
        raise ToolError("invalid_argument", "prompt is empty")
    account = spec.get("account") or "any"
    if account != "any" and account not in cfg["accounts"]:
        raise ToolError("unknown_account", "unknown account %r (known: %s)" % (account, ", ".join(cfg["accounts"]) or "none"))
    if account == "any" and not cfg["accounts"]:
        raise ToolError("no_accounts", "no accounts configured; run `cdeck_jobs.py init`")
    cwd = os.path.abspath(os.path.expanduser(_str(spec.get("cwd"), "cwd", max_len=4096) or HOME))
    if not os.path.isdir(cwd):
        raise ToolError("cwd_missing", "working directory does not exist: %s" % cwd)
    tag = _str(spec.get("tag"), "tag", max_len=80)
    if tag is not None and not TAG_RE.match(tag):
        raise ToolError("invalid_argument", "tag may contain letters, digits and . _ : / - only")
    priority = spec.get("priority") or 0
    if not isinstance(priority, int) or isinstance(priority, bool):
        raise ToolError("invalid_argument", "priority must be an integer")
    options = validate_options(cfg, merged_opts)
    job_id = "j_" + uuid.uuid4().hex[:12]
    conn.execute(
        "INSERT INTO jobs(id, created_at, tag, priority, account_req, cwd, prompt, options, state, max_attempts, timeout_s, parent_id) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (job_id, now(), tag, priority, account, cwd, prompt, json.dumps(options), "queued",
         int(options.get("max_attempts") or cfg["default_max_attempts"]), int(options.get("timeout_s") or cfg["default_timeout_s"]),
         spec.get("parent_id")))
    return job_id


def job_summary(row):
    t = now()
    started, finished = row["started_at"], row["finished_at"]
    d = {
        "id": row["id"], "state": row["state"], "account": row["account"] or row["account_req"], "tag": row["tag"],
        "cwd": row["cwd"], "attempts": row["attempts"], "created": iso(row["created_at"]),
    }
    if started:
        d["runtime_s"] = round((finished or t) - started, 1)
    if row["state"] == "queued" and row["not_before"] and row["not_before"] > t:
        d["retry_in_s"] = round(row["not_before"] - t)
    if row["error"] and row["state"] != "done":
        d["error"] = row["error"][:300]
    if row["state"] in TERMINAL:
        d["collected"] = bool(row["collected"])
    if row["cost_usd"] is not None:
        d["cost_usd"] = round(row["cost_usd"], 4)
    return d


def select_jobs(conn, args, states=None, limit=None):
    where, params = [], []
    ids = args.get("job_ids")
    if ids is not None:
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise ToolError("invalid_argument", "job_ids must be a list of strings")
        if not ids:
            return []
        where.append("id IN (%s)" % ",".join("?" * len(ids)))
        params += ids
    if args.get("tag"):
        where.append("tag=?")
        params.append(args["tag"])
    if args.get("account"):
        where.append("COALESCE(account, account_req)=?")
        params.append(args["account"])
    st = states or args.get("states") or ([args["state"]] if args.get("state") else None)
    if st:
        bad = [s for s in st if s not in STATES]
        if bad:
            raise ToolError("invalid_argument", "unknown state(s): %s" % ", ".join(bad))
        where.append("state IN (%s)" % ",".join("?" * len(st)))
        params += st
    sql = "SELECT * FROM jobs" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY created_at"
    if limit:
        sql += " LIMIT %d" % int(limit)
    return conn.execute(sql, params).fetchall()


def get_job(conn, job_id):
    row = conn.execute("SELECT * FROM jobs WHERE id=?", (_str(job_id, "job_id", required=True),)).fetchone()
    if not row:
        raise ToolError("not_found", "no job %s" % job_id)
    return row


def t_list_accounts(args):
    cfg = load_config()
    conn = db()
    out = []
    for name, acc in cfg["accounts"].items():
        st = account_state(conn, name)
        counts = dict(conn.execute("SELECT state, COUNT(*) FROM jobs WHERE COALESCE(account, account_req)=? "
                                   "AND state IN ('queued','running') GROUP BY state", (name,)).fetchall())
        item = {
            "account": name,
            "config_dir": acc["config_dir"] or "~/.claude (default)",
            "enabled": acc["enabled"],
            "max_parallel": st["max_parallel"] if st["max_parallel"] is not None else acc["max_parallel"],
            "running": counts.get("running", 0),
            "queued_pinned": counts.get("queued", 0),
        }
        if st["manual_pause"]:
            item["paused"] = "manually"
        elif st["paused_until"] > now():
            item["paused"] = st["pause_reason"] or "until %s" % iso(st["paused_until"])
        if st["rate_limit"]:
            try:
                r = json.loads(st["rate_limit"])
                item["rate_limit"] = {
                    "status": r.get("status"),
                    "windows": {k: {"used": v.get("utilization"), "resets": iso(v.get("resetsAt"))}
                                for k, v in (r.get("unifiedWindows") or {}).items() if isinstance(v, dict)},
                }
            except ValueError:
                pass
        if args.get("check_auth"):
            item["auth"] = auth_status(cfg, acc["config_dir"])
        out.append(item)
    queued_any = conn.execute("SELECT COUNT(*) FROM jobs WHERE state='queued' AND account_req='any'").fetchone()[0]
    return {"accounts": out, "queued_for_any_account": queued_any, "daemon_running": daemon_running()}


def t_run(args):
    cfg = load_config()
    conn = db()
    with Tx(conn):
        job_id = make_job(conn, cfg, args)
    ensure_daemon()
    return {"job_id": job_id, "state": "queued"}


def t_run_many(args):
    jobs = args.get("jobs")
    if not isinstance(jobs, list) or not jobs:
        raise ToolError("invalid_argument", "jobs must be a non-empty list")
    if len(jobs) > 5000:
        raise ToolError("invalid_argument", "at most 5000 jobs per call")
    defaults = args.get("defaults") or {}
    cfg = load_config()
    conn = db()
    ids = []
    with Tx(conn):  # all or nothing
        for i, spec in enumerate(jobs):
            try:
                ids.append(make_job(conn, cfg, spec, defaults))
            except ToolError as e:
                raise ToolError(e.code, "jobs[%d]: %s" % (i, e.message))
    ensure_daemon()
    return {"job_ids": ids, "count": len(ids)}


def t_status(args):
    conn = db()
    rows = select_jobs(conn, args)
    counts = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    limit = int(args.get("limit") or 50)
    # Most relevant first: running, then failures, then queued, then the rest (newest first).
    order = {"running": 0, "failed": 1, "queued": 2, "cancelled": 3, "done": 4}
    shown = sorted(rows, key=lambda r: (order.get(r["state"], 9), -(r["finished_at"] or r["started_at"] or r["created_at"])))[:limit]
    return {"total": len(rows), "counts": counts, "jobs": [job_summary(r) for r in shown],
            "truncated": len(rows) > limit, "daemon_running": daemon_running()}


def t_wait(args):
    """Return finished-but-uncollected jobs (mode "next"), or wait until all are finished (mode "all")."""
    mode = args.get("mode") or "next"
    if mode not in ("next", "all"):
        raise ToolError("invalid_argument", "mode must be \"next\" or \"all\"")
    timeout = min(float(args.get("timeout_s") or 60), 600)
    limit = int(args.get("limit") or 50)
    conn = db()
    deadline = now() + timeout
    scope = {k: args[k] for k in ("job_ids", "tag", "account") if args.get(k) is not None}
    while True:
        rows = select_jobs(conn, scope)
        pending = [r for r in rows if r["state"] not in TERMINAL]
        if mode == "next":
            ready = [r for r in rows if r["state"] in TERMINAL and not r["collected"]]
            if ready or not pending:
                return {"finished": [job_summary(r) for r in ready[:limit]], "more_finished": max(0, len(ready) - limit),
                        "pending": len(pending), "timed_out": False}
        elif not pending:
            return {"finished": [job_summary(r) for r in rows[-limit:]], "total": len(rows), "pending": 0, "timed_out": False}
        if now() >= deadline:
            return {"finished": [], "pending": len(pending), "timed_out": True}
        if pending and not daemon_running():
            ensure_daemon()
        time.sleep(1)


def t_result(args):
    conn = db()
    row = get_job(conn, args.get("job_id"))
    max_chars = int(args.get("max_chars") or 20000)
    text = row["result"]
    d = job_summary(row)
    d.update({
        "result": text[:max_chars] if isinstance(text, str) else text,
        "result_truncated": bool(isinstance(text, str) and len(text) > max_chars),
        "structured_output": json.loads(row["structured"]) if row["structured"] else None,
        "session_id": row["session_id"], "num_turns": row["num_turns"], "duration_ms": row["duration_ms"],
        "files": {"events": os.path.join(RUNS, row["id"], "events.jsonl"), "stderr": os.path.join(RUNS, row["id"], "stderr.log")},
    })
    if row["state"] not in TERMINAL:
        d["note"] = "job is still %s" % row["state"]
    elif args.get("collect", True):
        conn.execute("UPDATE jobs SET collected=1 WHERE id=?", (row["id"],))
    return d


def summarize_event(ev, width=300):
    t = ev.get("type")
    if t == "assistant":
        parts = []
        for c in (ev.get("message") or {}).get("content") or []:
            if c.get("type") == "text":
                parts.append(c.get("text", "")[:width])
            elif c.get("type") == "tool_use":
                inp = json.dumps(c.get("input"), ensure_ascii=False)
                parts.append("[tool %s] %s" % (c.get("name"), inp[:width]))
        return {"type": "assistant", "content": parts}
    if t == "user":
        parts = []
        content = (ev.get("message") or {}).get("content")
        for c in content if isinstance(content, list) else []:
            if c.get("type") == "tool_result":
                body = c.get("content")
                text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False)
                parts.append(("[error] " if c.get("is_error") else "[result] ") + (text or "")[:width])
        return {"type": "tool_results", "content": parts}
    if t == "result":
        return {"type": "result", "subtype": ev.get("subtype"), "is_error": ev.get("is_error"), "result": str(ev.get("result"))[:width]}
    if t == "system":
        return {"type": "system", "subtype": ev.get("subtype")}
    if t == "rate_limit_event":
        info = ev.get("rate_limit_info") or {}
        return {"type": "rate_limit", "status": info.get("status"), "resets": iso(info.get("resetsAt"))}
    return {"type": t}


def t_tail(args):
    conn = db()
    row = get_job(conn, args.get("job_id"))
    n = min(int(args.get("n") or 20), 200)
    events = read_events(os.path.join(RUNS, row["id"], "events.jsonl"), limit_bytes=2 * 1024 * 1024)
    shown = [summarize_event(e) for e in events if e.get("type") != "stream_event"][-n:]
    return {"job": job_summary(row), "events": shown, "stderr_tail": tail_text(os.path.join(RUNS, row["id"], "stderr.log"), 800)}


def t_cancel(args):
    if not args.get("job_ids") and not args.get("tag"):
        raise ToolError("invalid_argument", "give job_ids or tag")
    conn = db()
    with Tx(conn):
        rows = select_jobs(conn, {k: args.get(k) for k in ("job_ids", "tag") if args.get(k)}, states=["queued", "running"])
        for r in rows:
            conn.execute("UPDATE jobs SET cancel_requested=1 WHERE id=?", (r["id"],))
    if rows:
        ensure_daemon()
    return {"cancelling": [r["id"] for r in rows]}


def t_resume(args):
    """Continue a finished job's conversation (same account and folder) with a new prompt."""
    cfg = load_config()
    conn = db()
    parent = get_job(conn, args.get("job_id"))
    if parent["state"] not in TERMINAL:
        raise ToolError("busy", "job %s is still %s" % (parent["id"], parent["state"]))
    if not parent["session_id"]:
        raise ToolError("no_session", "job %s has no session to resume" % parent["id"])
    options = json.loads(parent["options"])
    options.pop("json_schema", None)
    options.pop("_continue_after_limit", None)
    options.pop("_pinned_from", None)
    options.update(args.get("options") or {})
    options["resume_session"] = parent["session_id"]
    spec = {"prompt": args.get("prompt"), "account": parent["account"], "cwd": parent["cwd"], "tag": args.get("tag", parent["tag"]),
            "options": options, "parent_id": parent["id"], "priority": args.get("priority", parent["priority"])}
    with Tx(conn):
        job_id = make_job(conn, cfg, spec)
    ensure_daemon()
    return {"job_id": job_id, "state": "queued", "resumes": parent["id"], "account": parent["account"]}


def t_retry(args):
    conn = db()
    with Tx(conn):
        rows = select_jobs(conn, {k: args.get(k) for k in ("job_ids", "tag") if args.get(k)}, states=["failed", "cancelled"])
        for r in rows:
            conn.execute("UPDATE jobs SET state='queued', account=NULL, cancel_requested=0, attempts=0, not_before=0, error=NULL, "
                         "finished_at=NULL, started_at=NULL, collected=0 WHERE id=?", (r["id"],))
    if rows:
        ensure_daemon()
    return {"requeued": [r["id"] for r in rows]}


def t_set_account(args):
    cfg = load_config()
    name = args.get("account")
    if name not in cfg["accounts"]:
        raise ToolError("unknown_account", "unknown account %r" % name)
    conn = db()
    fields = {}
    if "paused" in args:
        fields["manual_pause"] = 1 if args["paused"] else 0
        if not args["paused"]:
            fields["paused_until"] = 0
            fields["pause_reason"] = None
    if "max_parallel" in args:
        mp = args["max_parallel"]
        if mp is not None and (not isinstance(mp, int) or mp < 0 or mp > 32):
            raise ToolError("invalid_argument", "max_parallel must be 0..32 or null (config default)")
        fields["max_parallel"] = mp
    if not fields:
        raise ToolError("invalid_argument", "give paused and/or max_parallel")
    with Tx(conn) as c:
        upsert_account(c, name, **fields)
    if conn.execute("SELECT COUNT(*) FROM jobs WHERE state IN ('queued','running')").fetchone()[0]:
        ensure_daemon()  # new capacity or an unpaused account should take effect right away
    return [a for a in t_list_accounts({})["accounts"] if a["account"] == name][0]


def t_forget(args):
    """Delete finished jobs and their files (only done/failed/cancelled)."""
    import shutil
    conn = db()
    scope = {k: args.get(k) for k in ("job_ids", "tag") if args.get(k)}
    if not scope and not args.get("older_than_days"):
        raise ToolError("invalid_argument", "give job_ids, tag or older_than_days")
    rows = select_jobs(conn, scope, states=list(TERMINAL))
    if args.get("older_than_days"):
        cutoff = now() - float(args["older_than_days"]) * 86400
        rows = [r for r in rows if (r["finished_at"] or 0) < cutoff]
    with Tx(conn):
        for r in rows:
            conn.execute("DELETE FROM jobs WHERE id=?", (r["id"],))
    for r in rows:
        shutil.rmtree(os.path.join(RUNS, r["id"]), ignore_errors=True)
    return {"deleted": len(rows)}


# ------------------------------------------------------------------------------- tool definitions

S = {"type": "string"}
I = {"type": "integer"}
IDS = {"type": "array", "items": S, "description": "Job ids"}
OPTIONS = {
    "type": "object",
    "description": "claude -p settings (all optional)",
    "properties": {
        "model": dict(S, description="e.g. opus, sonnet, haiku or a full model id"),
        "effort": {"type": "string", "enum": ["low", "medium", "high", "xhigh", "max"], "description": "Thinking effort (--effort)"},
        "fallback_model": S,
        "permission_mode": {"type": "string", "enum": list(PERMISSION_MODES),
                            "description": "Non-interactive jobs cannot answer permission prompts: use acceptEdits and/or allowed_tools for jobs that edit files or run commands. bypassPermissions must be enabled in the config."},
        "allowed_tools": {"type": "array", "items": S, "description": "e.g. [\"Read\", \"Edit\", \"Bash(git diff:*)\"]"},
        "disallowed_tools": {"type": "array", "items": S},
        "max_turns": I,
        "max_budget_usd": {"type": "number"},
        "append_system_prompt": S,
        "system_prompt": S,
        "json_schema": {"description": "JSON Schema the final answer must follow; returned as structured_output"},
        "add_dirs": {"type": "array", "items": S},
        "mcp_config": dict(S, description="Path or JSON for --mcp-config"),
        "strict_mcp_config": {"type": "boolean"},
        "no_session_persistence": {"type": "boolean"},
        "timeout_s": dict(I, description="Kill the job after this many seconds (default from config, 3600)"),
        "max_attempts": dict(I, description="Attempts for transient failures (rate limits never count)"),
        "extra_args": {"type": "array", "items": S, "description": "Any other claude CLI flags, passed as-is"},
    },
}
JOB_SPEC = {
    "type": "object",
    "properties": {
        "prompt": dict(S, description="The full prompt (sent on stdin)"),
        "account": dict(S, description="Account name from list_accounts, or \"any\" (default) to use whichever has a free slot"),
        "cwd": dict(S, description="Working directory on the VM (default: home). Must exist."),
        "tag": dict(S, description="Optional label to group jobs, e.g. a run name; usable in status/wait/cancel"),
        "priority": dict(I, description="Higher runs first (default 0)"),
        "options": OPTIONS,
    },
    "required": ["prompt"],
}
SCOPE = {"job_ids": IDS, "tag": S, "account": S}

TOOLS = [
    ("list_accounts", "List Claude accounts jobs can run on: config dir, parallel slots, running/queued counts, rate-limit usage and reset times, pauses. check_auth=true also asks claude whether each account is signed in.",
     {"type": "object", "properties": {"check_auth": {"type": "boolean"}}}, t_list_accounts),
    ("run", "Queue one `claude -p` job on an account and return its job_id immediately. Jobs run in the background on the VM (several per account in parallel) and keep running if this session ends.",
     JOB_SPEC, t_run),
    ("run_many", "Queue many jobs in one call (all or none). Fields missing from a job are taken from `defaults` (account, cwd, tag, priority, options). Returns job ids in the same order.",
     {"type": "object", "properties": {"jobs": {"type": "array", "items": JOB_SPEC}, "defaults": {
         "type": "object", "properties": {"account": S, "cwd": S, "tag": S, "priority": I, "options": OPTIONS}}},
      "required": ["jobs"]}, t_run_many),
    ("status", "Counts by state plus job summaries (running and failed first). Filter by job_ids, tag, account or state(s).",
     {"type": "object", "properties": dict(SCOPE, state={"type": "string", "enum": list(STATES)},
                                           states={"type": "array", "items": {"type": "string", "enum": list(STATES)}},
                                           limit=dict(I, description="Max jobs listed (default 50)"))}, t_status),
    ("wait", "Block until jobs finish. mode \"next\" (default) returns as soon as any job in scope is finished but not yet collected by `result` — loop wait→result to process jobs as they complete. mode \"all\" waits until every job in scope is finished. Scope: job_ids, tag or account (default: all jobs).",
     {"type": "object", "properties": dict(SCOPE, mode={"type": "string", "enum": ["next", "all"]},
                                           timeout_s=dict(I, description="Max seconds to block (default 60, max 600)"),
                                           limit=dict(I, description="Max finished jobs returned (default 50)"))}, t_wait),
    ("result", "Final output of a job: result text, structured_output (with json_schema), session_id, cost, turns, error. Marks the job as collected (collect=false to peek).",
     {"type": "object", "properties": {"job_id": S, "max_chars": I, "collect": {"type": "boolean"}}, "required": ["job_id"]}, t_result),
    ("tail", "Recent activity of a job (assistant text, tool calls, tool results) to watch progress or debug.",
     {"type": "object", "properties": {"job_id": S, "n": dict(I, description="Events to show (default 20)")}, "required": ["job_id"]}, t_tail),
    ("cancel", "Cancel queued or running jobs (running ones get Ctrl+C, then are stopped). Give job_ids or tag.",
     {"type": "object", "properties": {"job_ids": IDS, "tag": S}}, t_cancel),
    ("resume", "Continue a finished job's conversation with a new prompt (same account, folder and options). Returns a new job_id.",
     {"type": "object", "properties": {"job_id": S, "prompt": S, "tag": S, "priority": I, "options": OPTIONS}, "required": ["job_id", "prompt"]}, t_resume),
    ("retry", "Requeue failed or cancelled jobs (by job_ids or tag).",
     {"type": "object", "properties": {"job_ids": IDS, "tag": S}}, t_retry),
    ("set_account", "Pause/unpause an account for new jobs, or change how many jobs it runs at once (null = config default). Running jobs are not affected.",
     {"type": "object", "properties": {"account": S, "paused": {"type": "boolean"}, "max_parallel": {"type": ["integer", "null"]}},
      "required": ["account"]}, t_set_account),
    ("forget", "Delete finished jobs and their logs by job_ids, tag and/or older_than_days.",
     {"type": "object", "properties": {"job_ids": IDS, "tag": S, "older_than_days": {"type": "number"}}}, t_forget),
]
TOOL_FUNCS = {name: fn for name, _, _, fn in TOOLS}


def call_tool(name, args):
    fn = TOOL_FUNCS.get(name)
    if not fn:
        raise ToolError("unknown_tool", "unknown tool %s" % name)
    if not isinstance(args, dict):
        raise ToolError("invalid_argument", "arguments must be an object")
    try:
        return fn(args)
    finally:
        close_db()


# ------------------------------------------------------------------------------------- MCP server

PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")


def mcp_serve(stdin=sys.stdin, stdout=sys.stdout):
    lock = threading.Lock()

    def send(msg):
        with lock:
            stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
            stdout.flush()

    def handle(msg):
        mid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params") or {}
        if mid is None:
            return  # notification
        try:
            if method == "initialize":
                want = params.get("protocolVersion")
                res = {"protocolVersion": want if want in PROTOCOLS else PROTOCOLS[0],
                       "capabilities": {"tools": {"listChanged": False}},
                       "serverInfo": {"name": "claude-jobs", "version": VERSION},
                       "instructions": "Run `claude -p` jobs under any configured Claude account. Typical loop: list_accounts → run_many → "
                                       "wait (mode next) → result for each finished job → queue more. Jobs run on the VM and survive this session."}
            elif method == "ping":
                res = {}
            elif method == "tools/list":
                res = {"tools": [{"name": n, "description": d, "inputSchema": s} for n, d, s, _ in TOOLS]}
            elif method == "tools/call":
                try:
                    data = call_tool(params.get("name"), params.get("arguments") or {})
                    res = {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=1)}],
                           "structuredContent": data if isinstance(data, dict) else {"items": data}, "isError": False}
                except ToolError as e:
                    res = {"content": [{"type": "text", "text": json.dumps({"error": e.code, "message": e.message})}], "isError": True}
            else:
                send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found: %s" % method}})
                return
            send({"jsonrpc": "2.0", "id": mid, "result": res})
        except Exception as e:  # never kill the server on one bad request
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32603, "message": "%s: %s" % (type(e).__name__, e)}})

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "parse error"}})
            continue
        # `wait` can block for minutes; handle calls on threads so other calls are not stuck behind it.
        threading.Thread(target=handle, args=(msg,), daemon=True).start()
    return 0


# ------------------------------------------------------------------------------------------- main

def main(argv):
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__)
        print("Tools: " + ", ".join(TOOL_FUNCS))
        return 0
    cmd = argv[0]
    if cmd == "mcp":
        return mcp_serve()
    if cmd == "daemon":
        return cmd_daemon(argv[1:])
    if cmd == "init":
        return cmd_init(argv[1:])
    if cmd == "version":
        print(VERSION)
        return 0
    if cmd in TOOL_FUNCS:
        try:
            raw = argv[1] if len(argv) > 1 else "{}"
            if raw == "-":
                raw = sys.stdin.read()
            elif raw.startswith("@"):  # large requests (e.g. run_many with long prompts) from a file
                with open(os.path.expanduser(raw[1:])) as f:
                    raw = f.read()
            args = json.loads(raw)
            print(json.dumps(call_tool(cmd, args), indent=2, ensure_ascii=False))
            return 0
        except ToolError as e:
            print(json.dumps({"error": e.code, "message": e.message}), file=sys.stderr)
            return 1
        except ValueError as e:
            print(json.dumps({"error": "invalid_json", "message": str(e)}), file=sys.stderr)
            return 2
    print("unknown command %r; see --help" % cmd, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
