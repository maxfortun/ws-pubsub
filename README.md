# ws-pubsub

A WebSocket gateway that works like a reverse proxy for socket messages. It
terminates browser WebSockets and relays every message onto Redis Streams;
backends consume them and answer through Redis. The gateway knows nothing
about the apps behind it.

```
browser ──ws──> ws-pubsub ──XADD──> ws-<ENV>.req.<realm>        ──> backend(s) of that realm
browser <──ws── ws-pubsub <──XADD── ws-<ENV>.res.<gateway id>   <── backend
```

- The **realm** (sent by the client when connecting) names the request stream
  `ws-<ENV>.req.<realm>`. Any backend reading that stream picks the messages
  up; that is the whole routing model.
- Each gateway process has its own **response stream**
  `ws-<ENV>.res.<gateway instance id>`. Every request carries it as
  `addr.topic`; a backend replies there, addressing the socket by `addr.ws`.
- Several gateway processes and pods can run side by side: a reply always
  goes back to the process holding that socket.

## Connecting

```
wss://<gateway host>/            (any path)
Sec-WebSocket-Protocol: <base64("ws-realm: dating")>[, <base64("name: value")>, ...]
```

Browsers can't set arbitrary headers on a WebSocket, so the client passes
its parameters as subprotocols: each one is `base64("name: value")` (padding
may be stripped), comma-separated. Subprotocols that don't decode to
`name: value` are kept as plain protocol names.

| Subprotocol parameter | Required | Meaning |
|---|---|---|
| `ws-realm` | yes | Which app's channels this socket talks to: requests go to `ws-<ENV>.req.<realm>`. A socket without a realm gets `{ "error": "Missing realm" }` and is closed with 1008. |

Subprotocol values are chosen by the client, so they never set connection
facts (IP, origin, …), and the realm is not an authorization: any client
can name any realm (see Known gaps).

## HTTP request headers

Read once, from the upgrade request. They become the `conn` object of the
`open` event (below); nothing else is taken from the client's headers.

| Header | `conn` field | Meaning |
|---|---|---|
| `X-Forwarded-For` | `ip` | Client address. Only the entry added by the outermost trusted proxy counts (`TRUSTED_PROXY_HOPS`); entries to its left are whatever the client sent. Without the header: the socket's remote address. |
| `Origin` | `origin` | Page that opened the socket. Checked against `WS_ALLOWED_ORIGINS`: browsers let any site open a WebSocket to this gateway carrying the user's cookies. |
| `User-Agent` | `user_agent` | Browser and OS, e.g. for counting unique visitors. Truncated to 512 characters. |
| `Accept-Language` | `accept_language` | Preferred languages, e.g. `en-US,en;q=0.9`: a default locale before the user picks one. |
| `Sec-GPC` | `gpc` (boolean) | Global Privacy Control. `1` means the user opts out of the sale/sharing of their data; legally binding in some places (California CPRA). |
| `Sec-CH-UA-Mobile` | `ua_mobile` | Client hint `?1` (mobile) or `?0`; sent by Chromium-based browsers. |
| `Sec-CH-UA-Platform` | `ua_platform` | Client hint, e.g. `"Android"`, `"Windows"`. |
| `Sec-WebSocket-Protocol` | – | Carries the subprotocol parameters above (`ws-realm`). |

All values are strings truncated to 512 characters; absent headers are
`undefined`. Cookies and `Authorization` are not forwarded: apps authenticate
inside the socket (e.g. an `auth` message with a token).

## Messages: gateway → backend

Each entry on `ws-<ENV>.req.<realm>` has one field, `message`, holding JSON:

| Field | When | Meaning |
|---|---|---|
| `addr.ws` | always | Id of the socket (random per connection). |
| `addr.topic` | always | Response stream of the gateway process holding the socket. Reply there. |
| `wsctl` | `open`, `close` | Socket lifecycle. Absent for ordinary messages. |
| `conn` | `open` only | Connection facts from the request headers (table above). Sent once; keep what you need in `meta`. |
| `meta` | always | Whatever backends stored on this socket with `set_meta` (e.g. user id after login). Empty until set. |
| `message` | client messages | The client's frame as a serialized Node Buffer (`{ "type": "Buffer", "data": [...] }`); `Buffer.from(message)` restores it. |
| `isBinary` | client messages | Whether the client sent a binary frame. |

## Messages: backend → gateway

Write to `addr.topic` (a field `message` holding JSON):

| Field | Meaning |
|---|---|
| `addr.ws` | Socket to deliver to. Unknown sockets (closed, or on another gateway) are ignored. |
| `message` | String sent to the client as-is. |
| `wsctl: 'set_meta'` + `meta` | Merge `meta` into the socket's meta; every later message from that socket carries it. Merge only: keys can be overwritten but not removed. |
| `wsctl: 'close'` | Close the socket. |

`message` and `wsctl` may be combined; the message is sent first.

## Settings

| Env | Default | Meaning |
|---|---|---|
| `ENV` | – | Environment name in stream names (`ws-<ENV>.req.*`, `ws-<ENV>.res.*`) and the consumer group `ws-pubsub-<ENV>`. |
| `PORT` | `3000` | Listen port (all paths). |
| `OS_CPUS` | `1` | Worker processes per pod (Node cluster). |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | `localhost`, `6379` | Redis. |
| `REDIS_SENTINELS` | – | Comma-separated `host:port` of Redis Sentinels; when set, used instead of `REDIS_HOST`. |
| `TRUSTED_PROXY_HOPS` | `1` | Proxies in front that append to `X-Forwarded-For` (1 for the Istio ingress gateway). `0` ignores the header and uses the socket address. |
| `WS_ALLOWED_ORIGINS` | (any) | Comma-separated origins allowed to open sockets, e.g. `https://geomatch.me,https://www.geomatch.me`. Others are closed with 1008. List the origins of every app using this gateway. |
| `DEBUG` | – | `debug` namespaces, e.g. `ws-pubsub:*`. Logs full messages, including tokens: not in production. |

Settings are read from the environment and `.env.local`.

## Known gaps

- **Realms are not authorized.** Any client can open a socket to any realm;
  backends must authenticate every request themselves.
- **Streams are never trimmed.** Entries are acknowledged but not deleted,
  so request streams grow without bound, a realm nobody consumes
  accumulates its messages instead of dropping them, and the response stream
  of a stopped gateway process remains. Needs `XADD MAXLEN`/`XTRIM` (or
  `XDEL` on ack) and cleanup of orphaned response streams.
- **Client frames are JSON-encoded Buffers** (one number per byte), several
  times the size of the frame.
- **`set_meta` can't remove keys** (e.g. on logout); backends overwrite them.
- `options.js` still carries `ezsso_*` settings that nothing uses.
