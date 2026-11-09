proxy reset priority
(authored by agents unless marked 🧑)

- 🧑 "Let the proxy agent make the proxy automatically prioritize accounts that would reset first"
- `scripts/proxy-reset-priority` reads Claude and Codex provider quota without generation
  - ranks enabled credentials separately per provider by the latest future reset (the weekly window when present)
    - unused five-hour capacity is not lost while the weekly window binds, so a five-hour reset must not outrank an earlier weekly reset
  - usable known windows precede unknown windows; exhausted accounts follow both
  - missing or failed quota responses preserve all priorities for that provider; expired windows are not projected forward
  - model-specific Claude limits remain the proxy's responsibility
- `--apply` patches credential priorities through the management API
  - disabled accounts remain untouched
  - no account reservations or quota redemption
- user `proxy-reset-priority.timer` refreshes each minute
  - service failures are visible in its journal
- session affinity is disabled in proxy configuration so previous bindings cannot override priority
  - requests already running finish normally
  - switching credentials may reduce prompt cache reuse
- rollback: stop and disable the timer; restore desired credential priorities and session affinity
