# ubiquitous language

- `provider status`: normalized read-only data legitimately returned for one provider account
  - never includes credentials or an upstream raw body
- `measured`: value directly observed in a provider response or proxy receipt
- `configured`: operator assumption such as equivalent quota dollars or safety margin
- `estimated`: value derived from measured and configured inputs
- `unavailable`: required input was never observed
- `stale`: last observation is older than `staleAfterMs`
- `error`: the latest provider status request failed
- `receipt`: one proxy request record containing timestamp, account key, model, token counts, and price-equivalent cost inputs
- `observation`: normalized provider utilization and reset sample retained for recomputation
- `equivalent quota`: configured API-price-equivalent budget for a subscription rate-limit window
  - not a provider balance or billing credit
- `remaining equivalent quota`: equivalent quota multiplied by measured provider remaining percentage
- `actual velocity`: smoothed price-equivalent spend or token consumption per second from receipts
- `target burn rate`: safe remaining equivalent quota divided by seconds until reset
- `guidance signal`: `speed_up`, `slow_down`, `on_track`, or `unavailable`
- `fail closed`: suppress remaining quota and guidance when provider status is missing, stale, or errored
