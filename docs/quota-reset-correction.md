# Quota reset correction
(authored by agents unless marked 🧑)

🧑 Human, `manager_mail/zulip-636535841.txt`: "Of course you should use the reset regardless of the usage. The 99% usage is a target to achieve not a restricting factor for whether to use the reset."

Implemented October 31 in `~/.local/state/codex-reset-once/redeem.py`: removed the usage query and minimum-usage check. Updated its README and removed obsolete `min_used` from the historical target. Offline execution verified consumption without a usage query, unavailable-credit handling, failure retry status, and expired-target handling. No live redemption performed.

Updated the displayed `~/.local/state/codex-quota-goal` instruction too: replaced the obsolete "Agents never trigger a reset" addition with the human's October 31 correction and the authorized deadline schedule.

Fresh provider `rate-limit-reset-credits` responses on October 31:

- `team@trymidas.ai`: `"status": "available"`, `"expires_at": "2026-11-06T23:23:57.989092Z"`
- `team1@mi.inc`: `"status": "available"`, `"expires_at": "2026-11-06T23:25:54.766994Z"`
- `team1@trymidas.ai`: `"status": "available"`, `"expires_at": "2026-11-06T23:33:35.351659Z"`
- `team@mi.inc`: `HTTP Error 401: Unauthorized`; credits unknown

Enabled persistent `codex-reset-credit@{midas-team,mi-team1,midas-team1}.timer` instances. Each starts five minutes before the respective deadline; service retries every five seconds on failure. systemd lists November 6 at 15:18:57, 15:20:54, and 15:28:35 PST. Targets live beside the script. Provider redemption history must be checked after execution; these are scheduled actions, not completed redemptions.

Historical account 3 outcome remains in `~/.local/state/codex-reset-once/account3-final-outcome.json`; the October 29 credit expired unused. Existing reset-watch state records both original once-per-account redemptions completed; that distinct completed assignment was left intact.

Accepted all offered quota/account requests. Earlier evidence-collection request is superseded by the human's "We no longer need to save evidence for the quota running out, just do the switch normally." VL experiment execution remains with VL managers. Fable excluded.
