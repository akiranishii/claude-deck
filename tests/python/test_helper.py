"""Unit tests for resources/remote/cdeck_helper.py (run with: python3 -m unittest discover -s tests/python)."""

import base64
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("cdeck_helper", ROOT / "resources" / "remote" / "cdeck_helper.py")
H = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(H)


REAL_SCREEN = "\n".join([
    "    ███ █ ▀▄▄▀▀ ▀▀▀ ▄▄▄▄▀ ▀█▀▀▄█▀▀ ▄▄",
    "    ▄  ▄▀▄▀ ▄▄ █▀ ▄██    ██  ▄▀   ▄▀",
    "",
    "\x1b[36m·✔︎·\x1b[39m \x1b[36mConnected\x1b[2m\x1b[39m · my_project_database · master\x1b[0m",
    "    \x1b[2mCapacity: 1/32 · New sessions will be created in the current directory\x1b[0m",
    "    Project 6",
    "\x1b[2mContinue coding in the Claude mobile app or https://claude.ai/code?environment=env_01Ex4mpleEnvironmentIdBb\x1b[0m",
    "space to show QR code · w to toggle spawn mode",
    "[08:22:33] Reconnected after 1s",
])


class Sanitize(unittest.TestCase):
    def test_strips_escapes_and_collapses_qr(self):
        lines = H.sanitize_lines(REAL_SCREEN)
        self.assertEqual(lines[0], "[QR code]")
        self.assertFalse(any("\x1b" in l for l in lines))
        self.assertIn("·✔︎· Connected · my_project_database · master", lines)

    def test_redacts_secrets_but_keeps_ids_and_paths(self):
        text = "\n".join([
            "ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnop",
            "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
            "token: Zx81kLm2QpRt7YuWv9AbCdEfGhIjKlMnOpQrStUvWxYz0123",
            "https://claude.ai/oauth/authorize?code=true&state=SECRETSTATE123&client_id=abc",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            "keep https://claude.ai/code/session_01Xy3ExampleSess10nIdAbc and /home/dev/my_project_database",
            "git 50351e0db6c9e0d7a1b2c3d4e5f60718293a4b5c",
        ])
        out = "\n".join(H.sanitize_lines(text))
        for secret in ("sk-ant-api03-abcdefghijklmnop", "abcdefghijklmnopqrstuvwxyz0123", "Zx81kLm2QpRt7YuWv9AbCdEfGhIjKlMnOpQrStUvWxYz0123", "SECRETSTATE123", "eyJhbGciOiJIUzI1NiJ9"):
            self.assertNotIn(secret, out)
        self.assertIn("session_01Xy3ExampleSess10nIdAbc", out)
        self.assertIn("/home/dev/my_project_database", out)

    def test_parse_screen(self):
        parsed = H.parse_screen(REAL_SCREEN)
        self.assertEqual(parsed["state_word"], "Connected")
        self.assertEqual(parsed["capacity"]["used"], 1)
        self.assertEqual(parsed["capacity"]["max"], 32)
        self.assertEqual(parsed["env_ids"], ["env_01Ex4mpleEnvironmentIdBb"])
        self.assertEqual(parsed["last_log"]["text"], "Reconnected after 1s")


class ArgvParsing(unittest.TestCase):
    def test_server_flags(self):
        argv = ["claude", "remote-control", "--name", "GCP Dev", "--spawn=same-dir", "--permission-mode", "bypassPermissions", "--capacity", "8", "--no-create-session-in-dir"]
        split = H.claude_argv_split(argv)
        self.assertEqual(H.classify_claude(split[1]), "rc-server")
        flags = H.parse_rc_server_args(split[1])
        self.assertEqual((flags["name"], flags["spawn"], flags["permission_mode"], flags["capacity"], flags["create_session_in_dir"]), ("GCP Dev", "same-dir", "bypassPermissions", 8, False))

    def test_session_child(self):
        argv = ["/x/claude.exe", "--print", "--sdk-url", "https://api.anthropic.com/v1/code/sessions/cse_01Xy3ExampleSess10nIdAbc", "--session-id", "cse_01Xy3ExampleSess10nIdAbc", "--model", "claude-opus-5-5"]
        split = H.claude_argv_split(argv)
        self.assertEqual(H.classify_claude(split[1]), "rc-session")
        info = H.parse_rc_session_args(split[1])
        self.assertEqual(info["cse_id"], "cse_01Xy3ExampleSess10nIdAbc")
        self.assertEqual(info["model"], "claude-opus-5-5")

    def test_node_installs_and_non_claude(self):
        self.assertIsNotNone(H.claude_argv_split(["node", "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", "remote-control"]))
        self.assertIsNone(H.claude_argv_split(["python3", "claude.py"]))
        self.assertIsNone(H.claude_argv_split(["bash", "-c", "claude remote-control"]))
        self.assertEqual(H.classify_claude(["--dangerously-skip-permissions"]), "interactive")
        self.assertEqual(H.classify_claude(["auth", "status"]), "subcommand")


class FakeProc(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.old = H.PROC_ROOT
        H.PROC_ROOT = self.root
        uid = os.getuid()
        self.uid = uid
        with open(os.path.join(self.root, "stat"), "w") as fh:
            fh.write("cpu 1 2 3\nbtime 1700000000\n")
        self._proc(10, 1, ["bash"], "bash", {"HOME": "/home/dev"})
        self._proc(20, 10, ["claude", "remote-control", "--name", "x"], "claude", {"CLAUDE_CONFIG_DIR": "/home/dev/.claude-account2", "AWS_SECRET_ACCESS_KEY": "supersecret", "CLAUDE_DECK_RUNTIME_ID": "rt_abc123"})
        self._proc(30, 20, ["claude.exe", "--print", "--sdk-url", "https://api.anthropic.com/v1/code/sessions/cse_01ABCDEFGHIJKLMNOPQRSTUV", "--session-id", "cse_01ABCDEFGHIJKLMNOPQRSTUV"], "claude.exe", {})

    def tearDown(self):
        H.PROC_ROOT = self.old
        shutil.rmtree(self.root)

    def _proc(self, pid, ppid, argv, comm, env):
        d = os.path.join(self.root, str(pid))
        os.makedirs(d)
        with open(os.path.join(d, "stat"), "w") as fh:
            fields = ["S", str(ppid), str(pid), "0", "0", str(pid)] + ["0"] * 13 + [str(pid * 100)] + ["0"] * 10
            fh.write("%d (%s) %s\n" % (pid, comm, " ".join(fields)))
        with open(os.path.join(d, "cmdline"), "wb") as fh:
            fh.write(b"\0".join(a.encode() for a in argv) + b"\0")
        with open(os.path.join(d, "environ"), "wb") as fh:
            fh.write(b"\0".join(("%s=%s" % kv).encode() for kv in env.items()) + b"\0")

    def test_process_tree(self):
        procs = H.read_proc_table(self.uid)
        self.assertEqual(sorted(procs), [10, 20, 30])
        self.assertEqual(sorted(H.descendants(procs, 10)), [20, 30])
        self.assertEqual(procs[20]["start"], "2000")
        self.assertTrue(H.process_alive(20, "2000"))
        self.assertFalse(H.process_alive(20, "9999"))  # pid reuse detected

    def test_only_whitelisted_env_is_read(self):
        env = H.read_whitelisted_env(20)
        self.assertEqual(env, {"CLAUDE_CONFIG_DIR": "/home/dev/.claude-account2", "CLAUDE_DECK_RUNTIME_ID": "rt_abc123"})
        self.assertNotIn("supersecret", json.dumps(env))
        self.assertEqual(H.config_dir_info(H.read_whitelisted_env(10)), {"state": "default", "value": None})
        self.assertEqual(H.config_dir_info(None), {"state": "unknown", "value": None})

    def test_nearest_rc_ancestor(self):
        procs = H.read_proc_table(self.uid)
        claude = H.claude_map(procs)
        self.assertEqual(H.nearest_claude_ancestor(procs, claude, 30, ("rc-server",)), 20)
        self.assertEqual(H.rc_server_in_pane(procs, claude, 10), 20)


class ClaudeMetadata(unittest.TestCase):
    def test_session_meta_whitelist(self):
        with tempfile.TemporaryDirectory() as cfg:
            os.makedirs(os.path.join(cfg, "sessions"))
            with open(os.path.join(cfg, "sessions", "30.json"), "w") as fh:
                json.dump({"pid": 30, "bridgeSessionId": "session_01ABCDEFGHIJKLMNOPQRSTUV", "name": "myproj-b9", "status": "idle", "procStart": "3000", "peerToken": "SECRET", "messagingSocketPath": "/run/x.sock"}, fh)
            with open(os.path.join(cfg, "sessions", "30.abc.key"), "w") as fh:
                fh.write('{"peerToken": "SECRET"}')
            meta = H.read_session_meta(cfg, 30)
            self.assertEqual(meta["bridgeSessionId"], "session_01ABCDEFGHIJKLMNOPQRSTUV")
            self.assertNotIn("peerToken", meta)
            self.assertNotIn("messagingSocketPath", meta)
            self.assertNotIn("SECRET", json.dumps(meta))

    def test_invalid_session_ids_are_dropped(self):
        with tempfile.TemporaryDirectory() as cfg:
            os.makedirs(os.path.join(cfg, "sessions"))
            with open(os.path.join(cfg, "sessions", "31.json"), "w") as fh:
                json.dump({"bridgeSessionId": "session_x/../../evil"}, fh)
            self.assertNotIn("bridgeSessionId", H.read_session_meta(cfg, 31))

    def test_bridge_pointers(self):
        with tempfile.TemporaryDirectory() as cfg:
            d = os.path.join(cfg, "projects", "-home-dev-myproj")
            os.makedirs(d)
            with open(os.path.join(d, "bridge-pointer.json"), "w") as fh:
                json.dump({"sessionId": "session_014ExampleConversat1onZz", "environmentId": "env_01Ex4mpleEnvironmentIdAa", "pid": 1987553, "procStart": "580889994"}, fh)
            ptrs = H.read_bridge_pointers(cfg)
            self.assertEqual(ptrs[0]["environmentId"], "env_01Ex4mpleEnvironmentIdAa")
            self.assertEqual(ptrs[0]["pid"], 1987553)


class LaunchArgv(unittest.TestCase):
    def test_rc_args_validation(self):
        self.assertEqual(H.build_rc_args({"name": "a b", "spawn": "worktree", "permission_mode": "default"}), ["--name", "a b", "--spawn", "worktree", "--permission-mode", "default"])
        with self.assertRaises(H.HelperError):
            H.build_rc_args({"spawn": "evil"})
        with self.assertRaises(H.HelperError):
            H.build_rc_args({"permission_mode": "yolo"})
        with self.assertRaises(H.HelperError):
            H.build_rc_args({"name": "line\nbreak"})
        with self.assertRaises(H.HelperError):
            H.build_rc_args({"continue": True, "spawn": "same-dir"})
        self.assertEqual(H.build_rc_args({"continue": True, "permission_mode": "default"}), ["--permission-mode", "default", "--continue"])

    def test_pane_argv_scopes_config_dir_to_the_process(self):
        default = H.build_pane_argv("interactive-login", "/bin/bash", None, "rt_abc123", "/c/claude", ["--name", "x"])
        self.assertEqual(default, ["/bin/bash", "-lic", 'exec "$@"', "claude-deck", "env", "-u", "CLAUDE_CONFIG_DIR", "CLAUDE_DECK_RUNTIME_ID=rt_abc123", "/c/claude", "remote-control", "--name", "x"])
        acct = H.build_pane_argv("direct", "/bin/bash", "/home/dev/.claude-account3", "rt_abc123", "/c/claude", [])
        self.assertEqual(acct, ["env", "CLAUDE_CONFIG_DIR=/home/dev/.claude-account3", "CLAUDE_DECK_RUNTIME_ID=rt_abc123", "/c/claude", "remote-control"])

    def test_shell_wrapper_passes_arguments_verbatim(self):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, "claude")
            with open(fake, "w") as fh:
                fh.write('#!/bin/sh\nprintf "CFG=%s\\n" "${CLAUDE_CONFIG_DIR-<unset>}"\nfor a in "$@"; do printf "<%s>\\n" "$a"; done\n')
            os.chmod(fake, 0o755)
            evil = "$(touch %s/pwned); 'q' `id`" % d
            argv = H.build_pane_argv("login", "/bin/sh", None, "rt_abc123", fake, ["--name", evil])
            env = dict(os.environ, CLAUDE_CONFIG_DIR="/inherited/from/shell")
            out = subprocess.run(argv, stdout=subprocess.PIPE, universal_newlines=True, env=env).stdout.splitlines()
            self.assertEqual(out, ["CFG=<unset>", "<remote-control>", "<--name>", "<%s>" % evil])
            self.assertFalse(os.path.exists(os.path.join(d, "pwned")))
            argv = H.build_pane_argv("login", "/bin/sh", "/home/dev/.claude-account2", "rt_abc123", fake, [])
            self.assertEqual(subprocess.run(argv, stdout=subprocess.PIPE, universal_newlines=True, env=env).stdout.splitlines()[0], "CFG=/home/dev/.claude-account2")


class TmuxEscaping(unittest.TestCase):
    def test_start_directory_hash_is_escaped(self):
        self.assertEqual(H.tmux_dir("/home/dev/C#Tools/x##y"), "/home/dev/C##Tools/x####y")

    def test_trailing_semicolon_is_escaped(self):
        self.assertEqual(H.tmux_args(["--name", "proj;", ";", "a;b"]), ["--name", "proj\\;", "\\;", "a;b"])
        with self.assertRaises(H.HelperError):
            H.tmux_arg("odd\\;")

    def test_prompt_detection(self):
        for prompt in ("dev@my-vm:~/myproj$", "root@box:/# ", "me@mac ~ %", "\u276f", "> "):
            self.assertTrue(H.PROMPT_RE.search(prompt), prompt)
        for line in ("ssh prod ", "echo 'unterminated", "Remote Control (fake)"):
            self.assertFalse(H.PROMPT_RE.search(line), line)

    def test_email_validation(self):
        self.assertTrue(H.EMAIL_RE.match("me@example.com"))
        for bad in ("me@example.com;", "me@ex ample.com", "me@example", "a;b@x.io"):
            self.assertFalse(H.EMAIL_RE.match(bad), bad)


class Paths(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.old_home = os.environ.get("HOME")
        os.environ["HOME"] = self.home

    def tearDown(self):
        if self.old_home is not None:
            os.environ["HOME"] = self.old_home
        shutil.rmtree(self.home)

    def test_expand_path(self):
        self.assertEqual(H.expand_path("~/projects/../x"), os.path.join(self.home, "x"))
        with self.assertRaises(H.HelperError):
            H.expand_path("relative/path")
        with self.assertRaises(H.HelperError):
            H.expand_path("/tmp/a\nb")

    def test_mkdir_creates_but_never_overwrites(self):
        res = H.op_mkdir({"path": "~/projects/new-research"})
        self.assertTrue(os.path.isdir(res["path"]))
        marker = os.path.join(res["path"], "keep.txt")
        open(marker, "w").close()
        with self.assertRaises(H.HelperError) as ctx:
            H.op_mkdir({"path": "~/projects/new-research"})
        self.assertEqual(ctx.exception.code, "exists")
        self.assertTrue(os.path.exists(marker))

    def test_mkdir_refuses_missing_parents_outside_home(self):
        with self.assertRaises(H.HelperError):
            H.op_mkdir({"path": "/nonexistent-root-%d/x" % os.getpid()})

    def test_list_dir(self):
        os.makedirs(os.path.join(self.home, "a", ".git"))
        os.makedirs(os.path.join(self.home, ".hidden"))
        open(os.path.join(self.home, "file.txt"), "w").close()
        res = H.op_list_dir({"path": "~"})
        self.assertEqual([e["name"] for e in res["entries"]], ["a"])
        self.assertTrue(res["entries"][0]["is_git"])
        self.assertEqual([e["name"] for e in H.op_list_dir({"path": "~", "show_hidden": True})["entries"]], [".hidden", "a"])

    def test_config_dir_creation_is_restricted(self):
        self.assertTrue(H.op_create_config_dir({"path": "~/.claude-account6"})["created"])
        self.assertEqual(oct(os.stat(os.path.join(self.home, ".claude-account6")).st_mode & 0o777), "0o700")
        for bad in ("~/notclaude", "~/sub/.claude-x", "/tmp/.claude-x"):
            with self.assertRaises(H.HelperError):
                H.op_create_config_dir({"path": bad})


class Protocol(unittest.TestCase):
    def test_entry_emits_marker_line(self):
        buf = io.StringIO()
        req = base64.b64encode(json.dumps({"op": "nope"}).encode()).decode()
        with redirect_stdout(buf):
            H.entry(req)
        line = buf.getvalue().strip()
        self.assertTrue(line.startswith(H.RESULT_MARKER))
        payload = json.loads(line[len(H.RESULT_MARKER):])
        self.assertEqual(payload["error"]["code"], "unknown_op")

    def test_rejects_bad_socket_and_args(self):
        self.assertEqual(H.handle({"op": "probe", "tmux_socket": "../x"})["error"]["code"], "bad_request")
        self.assertEqual(H.handle({"op": "probe", "args": "x"})["error"]["code"], "bad_request")
        self.assertEqual(H.handle({"op": "stop_runtime", "args": {"pane_id": "%1; kill"}})["error"]["code"], "invalid_argument")

    def test_login_url_allowlist(self):
        self.assertTrue(H.login_url_ok("https://claude.ai/oauth/authorize?code=true"))
        self.assertFalse(H.login_url_ok("https://evil.com/oauth/authorize"))
        self.assertFalse(H.login_url_ok("http://claude.ai/oauth/authorize"))


@unittest.skipUnless(shutil.which("tmux") and os.path.isdir("/proc/self"), "needs tmux and Linux /proc (the helper targets Linux VMs)")
class IsolatedTmuxLifecycle(unittest.TestCase):
    """Runs launch/stop/restart/end against a private tmux server (-L) with a fake claude."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.sock = "cdeck-test-%d" % os.getpid()
        H.TMUX_SOCKET = self.sock
        os.symlink(sys.executable, os.path.join(self.dir, "claude"))
        with open(os.path.join(self.dir, "remote-control"), "w") as fh:
            fh.write("import signal,sys,time,os\nprint('\\u00b7\\u2714\\u00b7 Connected \\u00b7 fake')\nprint('CFG='+os.environ.get('CLAUDE_CONFIG_DIR','<unset>'))\nsys.stdout.flush()\nsignal.signal(signal.SIGINT, lambda *a: sys.exit(0))\nwhile True: time.sleep(1)\n")

    def tearDown(self):
        subprocess.run(["tmux", "-L", self.sock, "kill-server"], stderr=subprocess.DEVNULL)
        H.TMUX_SOCKET = None
        shutil.rmtree(self.dir)

    def test_lifecycle(self):
        args = {"mode": "new", "session_name": "cd-test-a1b2", "runtime_id": "rt_test01", "cwd": self.dir, "claude_path": os.path.join(self.dir, "claude"), "config_dir": self.dir, "options": {}, "shell_mode": "direct"}
        res = H.op_launch_runtime(args)
        time.sleep(1.0)
        snap = H.op_snapshot({"capture": True})
        server = [s for s in snap["servers"] if s["runtime_marker"] == "rt_test01"]
        self.assertEqual(len(server), 1)
        self.assertEqual(server[0]["config_dir"]["value"], self.dir)
        self.assertEqual(H.op_stop_runtime({"pane_id": res["pane_id"], "wait_seconds": 5})["state"], "stopped")
        res2 = H.op_launch_runtime(dict(args, mode="restart"))
        self.assertTrue(res2["respawned"])
        with self.assertRaises(H.HelperError):
            H.op_end_session({"session_name": "cd-test-a1b2", "runtime_id": "rt_other"})
        H.op_stop_runtime({"pane_id": res["pane_id"], "wait_seconds": 5})
        self.assertEqual(H.op_end_session({"session_name": "cd-test-a1b2", "runtime_id": "rt_test01"})["state"], "ended")


if __name__ == "__main__":
    unittest.main()
