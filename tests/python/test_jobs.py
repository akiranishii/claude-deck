"""Tests for resources/remote/cdeck_jobs.py (the `claude -p` job runner), using a fake `claude`.

The fake emits the same stream-json events as Claude Code 2.1.3xx and its behaviour is steered by
the prompt: SLEEP <s>, FAIL, CRASH, RATELIMIT (only on a config dir containing a `limit_once` file).
"""

import importlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SCRIPT = os.path.join(ROOT, "resources", "remote", "cdeck_jobs.py")
sys.path.insert(0, os.path.dirname(SCRIPT))

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys, time, uuid
prompt = sys.stdin.read()
argv = sys.argv[1:]
cfg = os.environ.get("CLAUDE_CONFIG_DIR", "<unset>")
log = os.environ.get("FAKE_LOG")
def emit(ev):
    sys.stdout.write(json.dumps(ev) + "\n"); sys.stdout.flush()
if log:
    with open(log, "a") as f: f.write("start %s %f\n" % (os.path.basename(cfg), time.time()))
sid = argv[argv.index("--resume") + 1] if "--resume" in argv else str(uuid.uuid4())
emit({"type": "system", "subtype": "init", "session_id": sid, "cwd": os.getcwd()})
def done(result, is_error=False, subtype="success", status=None, code=0):
    if log:
        with open(log, "a") as f: f.write("end %s %f\n" % (os.path.basename(cfg), time.time()))
    emit({"type": "result", "subtype": subtype, "is_error": is_error, "result": result, "session_id": sid,
          "total_cost_usd": 0.01, "num_turns": 1, "duration_ms": 5, "api_error_status": status})
    sys.exit(code)
if "BGSTOP" in prompt:
    if os.environ.get("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS") != "0":
        sys.stderr.write('Background tasks still running 10m after the last turn (subagent "WS1"); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.\n')
        done("The research workstreams are still running.")
    done("finished after waiting for sub-agents")
if "BGSTOP" in prompt:
    if os.environ.get("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS") != "0":
        sys.stderr.write('Background tasks still running 10m after the last turn (subagent "WS1"); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.\n')
        done("The research workstreams are still running.")
    done("finished after waiting for sub-agents")
if "CRASH" in prompt:
    sys.stderr.write("segfault-ish\n"); sys.exit(3)
if "RATELIMIT" in prompt and os.path.exists(os.path.join(cfg, "limit_once")):
    os.remove(os.path.join(cfg, "limit_once"))
    reset = int(time.time()) + int(os.environ.get("FAKE_RESET_IN", "2"))
    emit({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": reset,
          "unifiedWindows": {"five_hour": {"utilization": 1.0, "resetsAt": reset, "status": "rejected"}}}})
    done("Claude usage limit reached", is_error=True, subtype="error_during_execution", status=429, code=1)
emit({"type": "assistant", "message": {"content": [{"type": "text", "text": "working"}, {"type": "tool_use", "name": "Read", "input": {"file_path": "x"}}]}})
emit({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed", "resetsAt": int(time.time()) + 3600,
      "unifiedWindows": {"five_hour": {"utilization": 0.25, "resetsAt": int(time.time()) + 3600, "status": "allowed"}}}})
if "SLEEP" in prompt:
    time.sleep(float(prompt.split("SLEEP", 1)[1].split()[0]))
if "FAIL" in prompt:
    done("it broke", is_error=True, subtype="error_during_execution", code=1)
done(json.dumps({"prompt": prompt, "cfg": cfg, "argv": argv, "cwd": os.getcwd(),
                 "api_key": os.environ.get("ANTHROPIC_API_KEY")}))
'''


class JobsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cdeck-jobs-")
        self.home = os.path.join(self.tmp, "jobs")
        os.environ["CDECK_JOBS_HOME"] = self.home
        os.environ["FAKE_LOG"] = os.path.join(self.tmp, "fake.log")
        os.environ["ANTHROPIC_API_KEY"] = "test-key-should-not-reach-jobs"
        self.fake = os.path.join(self.tmp, "claude")
        with open(self.fake, "w") as f:
            f.write(FAKE_CLAUDE)
        os.chmod(self.fake, 0o755)
        self.dirs = {}
        for name in ("a", "b", "lim"):
            d = os.path.join(self.tmp, "cfg-" + name)
            os.mkdir(d)
            self.dirs[name] = d
        self.work = os.path.join(self.tmp, "work")
        os.mkdir(self.work)
        self.write_config({"a": {"config_dir": self.dirs["a"]}, "b": {"config_dir": self.dirs["b"]}})
        import cdeck_jobs
        self.j = importlib.reload(cdeck_jobs)

    def write_config(self, accounts, **extra):
        os.makedirs(self.home, exist_ok=True)
        cfg = {"claude_path": self.fake, "default_max_parallel": 2, "login_shell_env": False, "idle_exit_minutes": 0.1,
               "default_max_attempts": 2, "accounts": accounts}
        cfg.update(extra)
        with open(os.path.join(self.home, "config.json"), "w") as f:
            json.dump(cfg, f)

    def tearDown(self):
        try:
            with open(os.path.join(self.home, "daemon.lock")) as f:
                pid = int(f.read().strip() or 0)
            if pid:
                os.kill(pid, signal.SIGTERM)
        except (OSError, ValueError):
            pass
        time.sleep(0.3)
        shutil.rmtree(self.tmp, ignore_errors=True)
        for k in ("CDECK_JOBS_HOME", "FAKE_LOG", "ANTHROPIC_API_KEY"):
            os.environ.pop(k, None)

    def call(self, name, **args):
        return self.j.call_tool(name, args)

    def wait_all(self, timeout=30, **scope):
        res = self.call("wait", mode="all", timeout_s=timeout, **scope)
        self.assertFalse(res["timed_out"], res)
        return res

    # ------------------------------------------------------------------------------------------

    def test_run_uses_the_accounts_config_dir_and_stdin(self):
        jid = self.call("run", prompt="hello 'world' $(id)", account="b", cwd=self.work,
                        options={"model": "sonnet", "effort": "max", "allowed_tools": ["Read", "Bash(git diff:*)"], "max_turns": 3})["job_id"]
        self.wait_all(job_ids=[jid])
        res = self.call("result", job_id=jid)
        self.assertEqual(res["state"], "done")
        out = json.loads(res["result"])
        self.assertEqual(out["prompt"], "hello 'world' $(id)")
        self.assertEqual(out["cfg"], self.dirs["b"])
        self.assertEqual(os.path.realpath(out["cwd"]), os.path.realpath(self.work))
        self.assertIsNone(out["api_key"])  # an API key would bill the key, not the account
        self.assertEqual(out["argv"][:4], ["-p", "--output-format", "stream-json", "--verbose"])
        self.assertIn("--allowedTools", out["argv"])
        self.assertIn("Bash(git diff:*)", out["argv"])
        self.assertEqual(out["argv"][out["argv"].index("--effort") + 1], "max")
        self.assertTrue(res["session_id"])
        self.assertTrue(self.call("status", job_ids=[jid])["jobs"][0]["collected"])

    def test_default_account_unsets_config_dir(self):
        self.write_config({"main": {"config_dir": None}})
        os.environ["CLAUDE_CONFIG_DIR"] = "/somewhere/else"
        try:
            jid = self.call("run", prompt="x", account="main", cwd=self.work)["job_id"]
            self.wait_all(job_ids=[jid])
            self.assertEqual(json.loads(self.call("result", job_id=jid)["result"])["cfg"], "<unset>")
        finally:
            os.environ.pop("CLAUDE_CONFIG_DIR", None)

    def test_run_many_respects_per_account_parallelism(self):
        jobs = [{"prompt": "SLEEP 0.6 job %d" % i} for i in range(8)]
        ids = self.call("run_many", jobs=jobs, defaults={"cwd": self.work, "tag": "t1"})["job_ids"]
        self.assertEqual(len(ids), 8)
        self.wait_all(tag="t1")
        self.assertEqual(self.call("status", tag="t1")["counts"], {"done": 8})
        # Never more than 2 at once per account; both accounts used.
        events = []
        with open(os.environ["FAKE_LOG"]) as f:
            for line in f:
                kind, acct, ts = line.split()
                events.append((float(ts), 1 if kind == "start" else -1, acct))
        running = {}
        for _, delta, acct in sorted(events):
            running[acct] = running.get(acct, 0) + delta
            self.assertLessEqual(running[acct], 2)
        self.assertEqual(set(a for _, _, a in events), {"cfg-a", "cfg-b"})

    def test_rate_limit_pauses_the_account_until_reset_and_requeues(self):
        self.write_config({"lim": {"config_dir": self.dirs["lim"]}})
        open(os.path.join(self.dirs["lim"], "limit_once"), "w").close()
        jid = self.call("run", prompt="RATELIMIT then work", account="lim", cwd=self.work)["job_id"]
        paused = None
        for _ in range(100):
            acc = self.call("list_accounts")["accounts"][0]
            if acc.get("paused"):
                paused = acc
                break
            time.sleep(0.1)
        self.assertIsNotNone(paused, "account was never paused")
        self.assertEqual(paused["rate_limit"]["status"], "rejected")
        self.wait_all(job_ids=[jid], timeout=30)
        res = self.call("result", job_id=jid)
        self.assertEqual(res["state"], "done")
        self.assertEqual(res["attempts"], 2)

    def test_rate_limited_job_continues_its_own_conversation(self):
        self.write_config({"lim": {"config_dir": self.dirs["lim"]}, "a": {"config_dir": self.dirs["a"]}})
        open(os.path.join(self.dirs["lim"], "limit_once"), "w").close()
        self.call("set_account", account="a", paused=True)  # make the "any" job land on the limited account
        jid = self.call("run", prompt="RATELIMIT original task", cwd=self.work)["job_id"]
        for _ in range(100):
            row = self.j.db().execute("SELECT state, account_req, session_id FROM jobs WHERE id=?", (jid,)).fetchone()
            if row["account_req"] == "lim":
                break
            time.sleep(0.1)
        self.assertEqual(row["account_req"], "lim")  # pinned: the conversation lives in that account
        first_session = row["session_id"]
        self.call("set_account", account="a", paused=False)
        self.wait_all(job_ids=[jid], timeout=30)
        res = self.call("result", job_id=jid)
        self.assertEqual(res["state"], "done")
        self.assertEqual(res["session_id"], first_session)
        out = json.loads(res["result"])
        self.assertTrue(out["prompt"].startswith("You were interrupted by a usage limit"))
        self.assertEqual(out["argv"][out["argv"].index("--resume") + 1], first_session)

    def test_long_paused_account_reroutes_its_interrupted_job(self):
        # account "lim" hits a limit that resets only in an hour; with reroute_after_hours=0.5 the job moves on.
        self.write_config({"lim": {"config_dir": self.dirs["lim"]}, "a": {"config_dir": self.dirs["a"]}}, reroute_after_hours=0.5)
        open(os.path.join(self.dirs["lim"], "limit_once"), "w").close()
        os.environ["FAKE_RESET_IN"] = "3600"
        try:
            self.call("set_account", account="a", paused=True)  # make the "any" job land on the limited account
            jid = self.call("run", prompt="RATELIMIT original task", cwd=self.work)["job_id"]
            for _ in range(100):
                if self.j.db().execute("SELECT account_req FROM jobs WHERE id=?", (jid,)).fetchone()[0] == "lim":
                    break
                time.sleep(0.1)
            self.call("set_account", account="a", paused=False)
            self.wait_all(job_ids=[jid], timeout=30)
            res = self.call("result", job_id=jid)
            self.assertEqual(res["state"], "done")
            self.assertEqual(res["account"], "a")
            out = json.loads(res["result"])
            self.assertTrue(out["prompt"].startswith("NOTE: a previous run of this job was interrupted"))
            self.assertIn("RATELIMIT original task", out["prompt"])
            self.assertNotIn("--resume", out["argv"])
        finally:
            os.environ.pop("FAKE_RESET_IN", None)

    def test_job_pinned_by_the_user_is_not_rerouted(self):
        self.write_config({"lim": {"config_dir": self.dirs["lim"]}, "a": {"config_dir": self.dirs["a"]}}, reroute_after_hours=0.5)
        open(os.path.join(self.dirs["lim"], "limit_once"), "w").close()
        os.environ["FAKE_RESET_IN"] = "3600"
        try:
            jid = self.call("run", prompt="RATELIMIT pinned", account="lim", cwd=self.work)["job_id"]
            for _ in range(100):
                row = self.j.db().execute("SELECT state, options FROM jobs WHERE id=?", (jid,)).fetchone()
                if row["state"] == "queued" and "_continue_after_limit" in row["options"]:
                    break
                time.sleep(0.1)
            time.sleep(2)  # several scheduler passes
            row = self.j.db().execute("SELECT state, account_req FROM jobs WHERE id=?", (jid,)).fetchone()
            self.assertEqual((row["state"], row["account_req"]), ("queued", "lim"))
        finally:
            os.environ.pop("FAKE_RESET_IN", None)

    def test_any_account_moves_on_when_one_is_rate_limited(self):
        self.write_config({"lim": {"config_dir": self.dirs["lim"], "max_parallel": 1}, "a": {"config_dir": self.dirs["a"], "max_parallel": 1}})
        open(os.path.join(self.dirs["lim"], "limit_once"), "w").close()
        ids = self.call("run_many", jobs=[{"prompt": "RATELIMIT %d" % i} for i in range(4)], defaults={"cwd": self.work})["job_ids"]
        self.wait_all(job_ids=ids)
        self.assertEqual(self.call("status", job_ids=ids)["counts"], {"done": 4})

    def test_cancel_stops_a_running_job(self):
        jid = self.call("run", prompt="SLEEP 30", account="a", cwd=self.work)["job_id"]
        for _ in range(100):
            if self.call("status", job_ids=[jid])["jobs"][0]["state"] == "running":
                break
            time.sleep(0.1)
        row = self.j.db().execute("SELECT pid FROM jobs WHERE id=?", (jid,)).fetchone()
        self.assertIsNotNone(row["pid"])  # running always comes with a pid
        t0 = time.time()
        self.assertEqual(self.call("cancel", job_ids=[jid])["cancelling"], [jid])
        self.wait_all(job_ids=[jid], timeout=15)
        self.assertLess(time.time() - t0, 10)
        self.assertEqual(self.call("status", job_ids=[jid])["jobs"][0]["state"], "cancelled")
        with self.assertRaises(ProcessLookupError):
            os.kill(row["pid"], 0)

    def test_timeout_and_crash_retries(self):
        t = self.call("run", prompt="SLEEP 30", account="a", cwd=self.work, options={"timeout_s": 1})["job_id"]
        c = self.call("run", prompt="CRASH", account="b", cwd=self.work)["job_id"]
        # Crash retries back off 30s; skip the wait by clearing not_before as it is requeued.
        deadline = time.time() + 30
        while time.time() < deadline:
            self.j.db().execute("UPDATE jobs SET not_before=0 WHERE id=? AND state='queued'", (c,))
            if self.call("status", job_ids=[t, c])["counts"] == {"failed": 2}:
                break
            time.sleep(0.2)
        st = {j["id"]: j for j in self.call("status", job_ids=[t, c])["jobs"]}
        self.assertEqual(st[t]["state"], "failed")
        self.assertIn("timed out", st[t]["error"])
        self.assertEqual(st[c]["state"], "failed")
        self.assertEqual(st[c]["attempts"], 2)
        self.assertEqual(self.call("retry", job_ids=[c])["requeued"], [c])

    def test_background_agents_get_to_finish_and_cut_off_runs_are_not_done(self):
        ok = self.call("run", prompt="BGSTOP", account="a", cwd=self.work)["job_id"]
        self.wait_all(job_ids=[ok])
        self.assertEqual(self.call("result", job_id=ok)["result"], "finished after waiting for sub-agents")
        self.write_config({"a": {"config_dir": self.dirs["a"]}}, job_env={})  # old behaviour: Claude stops sub-agents
        cut = self.call("run", prompt="BGSTOP", account="a", cwd=self.work)["job_id"]
        self.wait_all(job_ids=[cut])
        res = self.call("result", job_id=cut)
        self.assertEqual(res["state"], "failed")
        self.assertIn("incomplete", res["error"])

    def test_background_agents_get_to_finish_and_cut_off_runs_are_not_done(self):
        ok = self.call("run", prompt="BGSTOP", account="a", cwd=self.work)["job_id"]
        self.wait_all(job_ids=[ok])
        self.assertEqual(self.call("result", job_id=ok)["result"], "finished after waiting for sub-agents")
        self.write_config({"a": {"config_dir": self.dirs["a"]}}, job_env={})  # old behaviour: Claude stops sub-agents
        cut = self.call("run", prompt="BGSTOP", account="a", cwd=self.work)["job_id"]
        self.wait_all(job_ids=[cut])
        res = self.call("result", job_id=cut)
        self.assertEqual(res["state"], "failed")
        self.assertIn("incomplete", res["error"])

    def test_failed_result_is_reported(self):
        jid = self.call("run", prompt="FAIL", account="a", cwd=self.work)["job_id"]
        self.wait_all(job_ids=[jid])
        res = self.call("result", job_id=jid)
        self.assertEqual(res["state"], "failed")
        self.assertIn("it broke", res["error"])
        self.assertEqual(res["attempts"], 1)  # a real failure is not retried

    def test_wait_next_returns_jobs_as_they_finish(self):
        fast = self.call("run", prompt="quick", account="a", cwd=self.work, tag="w")["job_id"]
        slow = self.call("run", prompt="SLEEP 2", account="b", cwd=self.work, tag="w")["job_id"]
        first = self.call("wait", tag="w", timeout_s=20)
        self.assertEqual([j["id"] for j in first["finished"]], [fast])
        self.assertEqual(first["pending"], 1)
        self.call("result", job_id=fast)
        second = self.call("wait", tag="w", timeout_s=20)
        self.assertEqual([j["id"] for j in second["finished"]], [slow])

    def test_resume_continues_the_same_session_on_the_same_account(self):
        jid = self.call("run", prompt="first", account="b", cwd=self.work)["job_id"]
        self.wait_all(job_ids=[jid])
        sid = self.call("result", job_id=jid)["session_id"]
        r = self.call("resume", job_id=jid, prompt="second")
        self.assertEqual(r["account"], "b")
        self.wait_all(job_ids=[r["job_id"]])
        out = self.call("result", job_id=r["job_id"])
        self.assertEqual(out["session_id"], sid)
        argv = json.loads(out["result"])["argv"]
        self.assertEqual(argv[argv.index("--resume") + 1], sid)

    def test_daemon_restart_picks_up_running_jobs(self):
        jid = self.call("run", prompt="SLEEP 2", account="a", cwd=self.work)["job_id"]
        for _ in range(100):
            if self.call("status", job_ids=[jid])["jobs"][0]["state"] == "running":
                break
            time.sleep(0.1)
        with open(os.path.join(self.home, "daemon.lock")) as f:
            os.kill(int(f.read()), signal.SIGKILL)
        time.sleep(0.3)
        self.assertFalse(self.j.daemon_running())
        self.wait_all(job_ids=[jid], timeout=20)  # wait restarts the daemon, which adopts the job
        self.assertEqual(self.call("result", job_id=jid)["state"], "done")

    def test_validation(self):
        bad = [
            (dict(prompt="x", account="nope"), "unknown_account"),
            (dict(prompt="x", options={"permission_mode": "bypassPermissions"}), "bypass_disabled"),
            (dict(prompt="x", options={"extra_args": ["--dangerously-skip-permissions"]}), "invalid_argument"),
            (dict(prompt="x", options={"extra_args": ["--output-format=text"]}), "invalid_argument"),
            (dict(prompt="x", options={"bogus": 1}), "invalid_argument"),
            (dict(prompt="x", options={"effort": "extreme"}), "invalid_argument"),
            (dict(prompt="x", cwd=os.path.join(self.tmp, "missing")), "cwd_missing"),
            (dict(prompt="  "), "invalid_argument"),
            (dict(prompt="x", tag="bad tag!"), "invalid_argument"),
        ]
        for args, code in bad:
            with self.assertRaises(self.j.ToolError) as cm:
                self.call("run", **args)
            self.assertEqual(cm.exception.code, code, args)
        # run_many is all-or-nothing.
        with self.assertRaises(self.j.ToolError):
            self.call("run_many", jobs=[{"prompt": "ok"}, {"prompt": "x", "account": "nope"}])
        self.assertEqual(self.call("status")["total"], 0)
        self.write_config({"a": {"config_dir": self.dirs["a"]}}, allow_bypass_permissions=True)
        self.assertTrue(self.call("run", prompt="x", options={"permission_mode": "bypassPermissions"}, cwd=self.work)["job_id"])

    def test_mcp_protocol(self):
        p = subprocess.Popen([sys.executable, SCRIPT, "mcp"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)

        def rpc(i, method, params=None):
            p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params or {}}) + "\n")
            p.stdin.flush()
            return json.loads(p.stdout.readline())

        try:
            init = rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t"}})
            self.assertEqual(init["result"]["protocolVersion"], "2025-06-18")
            p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
            names = [t["name"] for t in rpc(2, "tools/list")["result"]["tools"]]
            self.assertEqual(names[:4], ["list_accounts", "run", "run_many", "status"])
            run = rpc(3, "tools/call", {"name": "run", "arguments": {"prompt": "via mcp", "account": "a", "cwd": self.work}})
            jid = run["result"]["structuredContent"]["job_id"]
            waited = rpc(4, "tools/call", {"name": "wait", "arguments": {"job_ids": [jid], "mode": "all", "timeout_s": 20}})
            self.assertEqual(waited["result"]["structuredContent"]["finished"][0]["state"], "done")
            err = rpc(5, "tools/call", {"name": "run", "arguments": {"prompt": "x", "account": "nope"}})
            self.assertTrue(err["result"]["isError"])
            self.assertEqual(rpc(6, "bogus/method")["error"]["code"], -32601)
        finally:
            p.stdin.close()
            p.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
