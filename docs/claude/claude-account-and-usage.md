# Claude account switching and usage tracking

Every Claude agent on this machine shares one Claude Code login. Two logins
are saved: `midas` (the Midas team org, Max 5x seat) and `personal` (the
human's own org, Max 20x).

## switch back to personal (for a Codex agent)

Do this when the human asks, or after Midas quota ran out and the human
agreed to go back:

1. `claude-account` shows the active organization and saved names.
2. `claude-account use personal` saves the Midas login under `midas` and
   makes the personal one active.
3. Check: `claude auth status` shows `"orgName": "stevensichanghe@gmail.com's Organization"`
   and `"subscriptionType": "max"`; `claude-usage` shows the personal quota.
4. Agents started afterwards use the personal login. Running agents keep
   their old login until they restart; restart them through `amh`, at most
   2 per minute, only if they are stuck on a quota error.
5. Tell the human which login is active.

`claude-account use midas` switches back to Midas the same way.

If `claude auth status` shows `loggedIn: false` after a switch, the saved
login expired: switch back with `claude-account use midas` and tell the human
a fresh `claude auth login` is needed. Never print or copy the token files
anywhere else.

## usage tracking

- `claude-usage` prints the active org's percent used of the 5-hour and
  7-day windows and tokens per day and model.
- The `claude-usage.timer` (every 10 minutes) appends readings to
  `~/.local/state/claude-usage.jsonl` and adds new transcript tokens to
  `~/.local/state/claude-usage-tokens.json`, also counted per org.
- When a window of the active org reaches 100% or is locked, the timer saves
  an evidence bundle once in `~/claude_quota_evidence/ORG-WINDOW-RESET/`
  (`summary.md`, `usage_timeline.csv`, `tokens_by_day_model.csv`,
  `work_done.md`, `quota_at_exhaustion.json`) and emails the human its path.
