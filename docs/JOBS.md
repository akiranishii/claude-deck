# Claude jobs: run `claude -p` on any account from a main agent

`resources/remote/cdeck_jobs.py` gives one Claude Code session (the "main agent") MCP tools to start,
watch, collect, cancel and resume headless `claude -p` jobs under any of your Claude accounts.
The tools are generic: a job is just a prompt, an account (or `any`) and a working folder. Templating
and deciding what to run next are up to the main agent.

## Install

```bash
scripts/install-jobs.sh my-vm
```

This copies the script to `~/.claude-deck/jobs/` on the VM and writes `config.json` with every signed-in
account it finds (`~/.claude` → `main`, `~/.claude-work` → `work`, …). An existing config is kept.
Then register the tools with the session you want as the main agent:

```bash
# main agent on the Mac (tools run on the VM over one SSH connection)
claude mcp add --scope user claude-jobs -- ssh -T -o BatchMode=yes -o ServerAliveInterval=30 my-vm python3 .claude-deck/jobs/cdeck_jobs.py mcp

# main agent on the VM itself
claude mcp add --scope user claude-jobs -- python3 ~/.claude-deck/jobs/cdeck_jobs.py mcp
```

## Tools

| Tool | Purpose |
|---|---|
| `list_accounts(check_auth?)` | Accounts, parallel slots, running/queued, rate-limit usage per window and reset time, pauses |
| `run(prompt, account?, cwd?, tag?, priority?, options?)` | Queue one job, returns `job_id` at once |
| `run_many(jobs[], defaults?)` | Queue many (all or none); missing fields come from `defaults` |
| `status(job_ids? \| tag? \| account? \| state(s)?, limit?)` | Counts by state plus summaries (running and failed first) |
| `wait(scope, mode?, timeout_s?)` | `next`: return as soon as any job in scope is finished and not yet collected; `all`: until all finish |
| `result(job_id, max_chars?, collect?)` | Result text, `structured_output`, session id, cost, turns, error; marks the job collected |
| `tail(job_id, n?)` | Recent assistant text, tool calls and tool results |
| `cancel(job_ids \| tag)` | Ctrl+C, then stop |
| `resume(job_id, prompt)` | Continue that conversation (same account and folder) as a new job |
| `retry(job_ids \| tag)` | Requeue failed/cancelled jobs |
| `set_account(account, paused?, max_parallel?)` | Pause an account or change its concurrency at runtime |
| `forget(job_ids \| tag \| older_than_days)` | Delete finished jobs and their logs |

`options`: `model`, `effort`, `fallback_model`, `permission_mode`, `allowed_tools`, `disallowed_tools`, `max_turns`,
`max_budget_usd`, `append_system_prompt`, `system_prompt`, `json_schema`, `add_dirs`, `mcp_config`,
`strict_mcp_config`, `no_session_persistence`, `timeout_s`, `max_attempts`, `extra_args` (any other CLI flags).

A typical main-agent loop: `run_many` a first wave → `wait` (mode `next`) → `result` for each finished job →
queue more → repeat. Jobs run on the VM and keep going if the main agent's session ends; `status` and
`wait` pick them up again later.

## How it works

- Each job is `claude -p --output-format stream-json --verbose …` with the prompt on stdin, started from an
  argument list (no shell) in `cwd`, with `CLAUDE_CONFIG_DIR` set to the account's folder (unset for
  `main`). Claude credentials are never read; an account is only a config folder. `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` are removed from the job environment (they would bill the key instead of the
  account) unless the account sets `"keep_api_key_env": true`.
- A scheduler daemon (started automatically by any tool call, exits after `idle_exit_minutes` of nothing
  to do) runs up to `max_parallel` jobs per account. `account: "any"` jobs go to whichever account has
  the most free slots.
- **Usage limits:** Claude reports usage (5-hour and weekly windows) and reset times in its `rate_limit_event`;
  `list_accounts` shows them. A job that hits a limit is paused, not failed: its account is paused until Claude's
  reset time, and the job later **continues the same conversation** (full context) on that account with a short
  "you were interrupted, continue" message. If the account is paused for longer than `reroute_after_hours`
  (default 5.5 h, i.e. a weekly limit), the job instead restarts on another account and is told to review and finish
  the partial work in its folder. Jobs you pinned to a specific account always stay on it.
- **Background sub-agents:** `claude -p` normally stops background sub-agents 10 minutes after the main agent's last
  turn. The runner sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` for every job (configurable via `job_env`) so long
  multi-agent jobs can finish; a run whose sub-agents were stopped anyway is reported as failed ("incomplete"), never
  as done.
- **Failures:** API overloads, crashes and lost processes are retried with backoff up to `max_attempts`
  (default 2). Errors reported by Claude (e.g. `error_max_turns`) and timeouts are not retried.
- **Restarts:** state is in SQLite (`jobs.db`); event logs are in `runs/<job>/`. If the daemon dies, jobs keep
  running; the next daemon re-attaches (pid + start time) or retries jobs whose process is gone.
- **Permissions:** headless jobs can't answer permission prompts, so give jobs that edit files or run commands
  `permission_mode: "acceptEdits"` and/or `allowed_tools`. `bypassPermissions` is refused unless
  `"allow_bypass_permissions": true` is set in `config.json`.
- **Parallel edits:** jobs in the same folder can conflict. Give parallel jobs their own folders or git
  worktrees when they change files.
- No network ports are opened. The MCP server talks over stdio (directly, or through `ssh -T`).

## Config (`~/.claude-deck/jobs/config.json`)

```json
{
  "claude_path": null,
  "default_max_parallel": 2,
  "default_timeout_s": 3600,
  "default_max_attempts": 2,
  "allow_bypass_permissions": false,
  "idle_exit_minutes": 20,
  "login_shell_env": true,
  "reroute_after_hours": 5.5,
  "job_env": {"CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS": "0"},
  "accounts": {
    "main": {"config_dir": null, "max_parallel": 2},
    "work": {"config_dir": "~/.claude-work", "max_parallel": 3, "enabled": true},
    "api":  {"config_dir": "~/.claude-api", "max_parallel": 10}
  }
}
```

**API-key accounts.** An "account" is just a config directory, so it can authenticate with an API key instead of a
subscription login: configure the key in that directory's Claude Code settings (for example an `apiKeyHelper` in
`~/.claude-api/settings.json`). Alternatively set `"keep_api_key_env": true` on the account and start the runner with
`ANTHROPIC_API_KEY` in its environment. By default the runner strips `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` from
jobs so that subscription accounts are not accidentally billed to a key.

Changes are picked up without a restart. From a shell on the VM the same tools work as commands:
`python3 ~/.claude-deck/jobs/cdeck_jobs.py status '{"tag": "run1"}'`.

## Using it as an orchestrator

Register the MCP server with the session that should orchestrate (often the account you use interactively), and
pause that account for jobs so the orchestrator keeps headroom for itself (`set_account(account, paused=true)`).
Then give it a task, for example:

> Use the claude-jobs tools. For every file in `~/data/inputs/`, run a job with this prompt template:
> "Read {file} and write a one-page summary to `~/data/outputs/{name}.md`." Use `account: "any"`,
> cwd `~/data`, tag `summaries-1`, options `{"permission_mode": "acceptEdits", "effort": "high"}`.
> Keep about 10 jobs queued at a time; loop `wait` → `result`, check each output file exists, retry failures once,
> and report progress every 25 jobs and a list of failures at the end.

Practical tips:

- **Store long prompts in files** and submit with `cdeck_jobs.py run_many @jobs.json` from the VM (command-line
  arguments are size-limited); the MCP `run_many` tool is fine for normal prompt sizes.
- **Check outputs, not just job state.** A job can finish "done" with a thin result. Have the orchestrator (or a small
  script) verify the expected files exist and resume (`resume`) jobs whose output is incomplete.
- **Watch the weekly windows** in `list_accounts`: 5-hour limits pause and resume automatically, but weekly limits
  decide how much you can run per week.
- **Long prompts per job:** keep the exact prompt of each job (`runs/<job>/prompt.txt`) — it is saved automatically.

**Usage and terms.** The runner schedules within each account's own limits; it does not raise them. Check Anthropic's
terms for your plan before automating bulk work across several subscription accounts. For large automated workloads,
API-key accounts are the supported route.

## Tests

`npm run test:py` includes `tests/python/test_jobs.py` (fake `claude`): account isolation, per-account
parallelism, rate-limit pause and continuation of the same conversation, rerouting jobs stranded by long pauses,
moving `any` jobs to another account, background sub-agent handling, cancel, timeout, crash retries,
`wait`/`result` collection, resume, daemon restart and the MCP protocol.
