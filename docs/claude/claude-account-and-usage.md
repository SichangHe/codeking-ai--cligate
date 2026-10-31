# Claude account switching and usage tracking
(authored by agents unless marked 🧑)

Every Claude agent on this machine shares one Claude Code login. Two logins
are saved: `midas` (the Midas team org, Max 5x seat) and `personal` (the
human's own org, Max 20x).

## through the proxy (since 2026-10-17)

`~/.claude/settings.json` sends every Claude Code session to CLIProxyAPI
(`ANTHROPIC_BASE_URL=http://127.0.0.1:18318`). The proxy holds both logins in
`~/.local/share/cliproxyapi-trial/auths/claude-*.json`: Midas has `priority`
10, personal 0, and session affinity keeps a session on one login until it
runs out. While this is on, the `claude-usage` timer records usage and tells
`vl_catchup.md` when the monitored Midas quota becomes exhausted/locked or
available again. It does not pause agents or switch logins. To undo, remove the two `ANTHROPIC_*` entries
from `env` in `~/.claude/settings.json`.

October 31 verification: both proxy credentials authenticate. Midas reports
`default_claude_max_5x`; personal reports `default_claude_max_20x`. Personal
fallback is enabled, with the priorities above. The older saved logins under
`~/.local/state/claude-accounts/` return HTTP 401; do not use those copies to
replace the working proxy credentials. Renew a saved login before switching
outside the proxy.

VL owners retain experiment holds. The proxy cannot distinguish experiments
from steering or writing; enabling fallback does not authorize resuming held
experiments.
The quota notification reports provider availability, not which account billed
an individual proxy request.

## switch back to personal (for a Codex agent, without the proxy)

Do this when the human asks, or after Midas quota ran out and the human
agreed to go back:

1. `claude-account` shows the active organization and saved names.
2. `claude-account use personal` saves the Midas login under `midas` and
   makes the personal one active.
3. Check: `claude-account` prints `active organization: stevensichanghe@gmail.com's Organization`
   (it asks Anthropic which org the token belongs to; the name in
   `~/.claude.json` and `claude auth status` can be stale), and
   `claude-usage` shows the personal quota.
4. Agents started afterwards use the personal login. Running agents keep
   their old login until they restart; restart them through `amh`, at most
   2 per minute, only if they are stuck on a quota error.
5. Tell the human which login is active.

`claude-account use midas` switches back to Midas the same way.

If `claude-account` prints `active organization: unknown` after a switch,
the saved login expired (running sessions may have renewed it elsewhere): switch back with `claude-account use midas` and tell the human
a fresh `claude auth login` is needed. Never print or copy the token files
anywhere else.

## usage tracking

- `claude-usage` prints the active org's percent used of the 5-hour and
  7-day windows and tokens per day and model.
- The `claude-usage.timer` (every 10 minutes) appends readings to
  `~/.local/state/claude-usage.jsonl` and adds new transcript tokens to
  `~/.local/state/claude-usage-tokens.json`, also counted per org.
- The provider reports utilization percentages, not a fixed token allowance.
- Exhaustion evidence collection is disabled in the recording path.
  - 🧑 "We no longer need to save evidence for the quota running out, just do the switch normally."
  - source: human, `manager_mail/zulip-632586785.txt`
