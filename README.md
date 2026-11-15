# ws-pubsub
## Connection info

On `open` the gateway publishes `addr: { ws }` (routing) and `conn` (facts
about the connection, taken from the HTTP request only - never from
subprotocol values, which the client chooses):

| Field | From |
|---|---|
| `ip` | `X-Forwarded-For` entry added by the outermost trusted proxy (`TRUSTED_PROXY_HOPS`), else the socket address |
| `origin` | `Origin` |
| `user_agent` | `User-Agent` |
| `accept_language` | `Accept-Language` |
| `gpc` | `Sec-GPC: 1` (Global Privacy Control) |
| `ua_mobile`, `ua_platform` | `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform` |

`conn` is sent once; backends keep what they need in `meta` (which travels
with every message).

## Settings

| Env | Default | Meaning |
|---|---|---|
| `TRUSTED_PROXY_HOPS` | `1` | Proxies in front that append to `X-Forwarded-For` (1 for the Istio ingress gateway). `0` uses the socket address. |
| `WS_ALLOWED_ORIGINS` | (any) | Comma-separated origins allowed to open sockets, e.g. `https://geomatch.me,https://www.geomatch.me`. Set it: browsers let any site open a websocket to this gateway with the user's cookies. Other origins are closed with 1008. |
