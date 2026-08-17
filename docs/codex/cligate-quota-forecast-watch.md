# CLI-Gate quota forecast watcher

Use this watcher only for a comparable token forecast over one or two hours.

- `too_fast`: slow discretionary token-heavy work while preserving essential work and human-owned panes
- `too_slow`: pull useful deferred work forward when it is safe and bounded
- `on_track` or `unavailable`: do not notify

The watcher suppresses only a repeated notification of the same type for its configured window. A change from `too_fast` to `too_slow`, or vice versa, is a new notification and must be delivered.

The endpoint and CLI decide whether a notification is due. This component does not itself send to the main manager; a configured scheduler or caller must deliver a due decision directly.
