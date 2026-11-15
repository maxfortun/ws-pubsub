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
- Messages don't wait forever: each realm has a **TTL** (`WS_REALM_TTLS`).
  Requests older than that are trimmed from the stream, whether or not a
  backend ever reads them (see Message lifetime).

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
| `exp` | always | When this message expires (ms since epoch): written + the realm's TTL. Backends that support it skip expired requests that waited in the queue; backends that don't still never see entries older than the TTL. |
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
| `WS_REALM_TTLS` | `default=1h` | Per-realm message lifetime, e.g. `dating=5m,chat=1d,default=1h`. Durations: `ms`, `s`, `m`, `h`, `d` (plain numbers are ms). Realms not listed get `default`. |
| `WS_RESPONSE_TTL` | `1m` | Lifetime of replies in this process's response stream. |
| `TRUSTED_PROXY_HOPS` | `1` | Proxies in front that append to `X-Forwarded-For` (1 for the Istio ingress gateway). `0` ignores the header and uses the socket address. |
| `WS_ALLOWED_ORIGINS` | (any) | Comma-separated origins allowed to open sockets, e.g. `https://geomatch.me,https://www.geomatch.me`. Others are closed with 1008. List the origins of every app using this gateway. |
| `DEBUG` | – | `debug` namespaces, e.g. `ws-pubsub:*`. Logs full messages, including tokens: not in production. |

Settings are read from the environment and `.env.local`.

## Message lifetime

Stream entry ids are their creation time in ms, so trimming by id is
trimming by age (`MINID`, exact; needs Redis 6.2+):

- **Requests:** every write to `ws-<ENV>.req.<realm>` drops entries older
  than the realm's TTL, and stamps the new entry with `exp`. A realm nobody
  consumes therefore holds at most one TTL of messages; a backend that is
  down longer than the TTL loses the requests that expired meanwhile (their
  clients stopped waiting anyway).
- **Replies:** the response stream is trimmed to `WS_RESPONSE_TTL` by the
  gateway (periodically) and by backends that trim on write.
- **Stopped gateway processes:** each response stream has a key expiry
  (5 × `WS_RESPONSE_TTL`, at least 5 minutes) that the process keeps
  refreshing, so the stream of a process that's gone deletes itself.
- If a stream or consumer group disappears, readers recreate it.

Backend support is optional. A backend that supports lifetimes:

1. skips requests whose `exp` has passed (socket `open`/`close` events are
   still worth handling);
2. trims the response stream when it replies:
   `XADD <addr.topic> MINID <now - response ttl>-0 * message <json>`.

## Realms from ws-pubsub-admin

With `WSPA_MONGODB` set, the gateway reads realms registered in
ws-pubsub-admin (collection `realms`, cached for `WS_REALM_CACHE`):

- **Registered realm:** refused (1008) if disabled or the page's origin isn't
  in its `allowed_origins`. Its request and reply topics are rendered from
  its templates (`{realm}`, `{env}`, `{gateway}`, `{header.NAME}` from the
  client's subprotocol parameters; unsafe or missing values refuse the
  connection). Messages go to the realm's own backend with its TTL, and
  messages over `limits.max_message_bytes`, or binary ones unless
  `limits.allow_binary`, are answered with an error and dropped. Backend
  secrets are opened with `SECRETS_KEYS` (the admin's keys).
- **Unregistered realm** (e.g. `dating`): the platform Redis (`REDIS_*`)
  as before, or refused with `WS_REALMS_STRICT=true`.
- **Registry unreachable:** cached realms keep their settings, and other
  realms not on the last loaded list of registered ids use the platform
  Redis. A realm on that list but not cached is refused (1011): a
  registered realm's messages never go elsewhere. Only if the registry
  has been unreachable since the gateway started is there no list, and
  then unknown realms use the platform Redis (refused when strict). An
  outage adds no delay: lookups are skipped until the registry is back.

Supported backends: Redis Streams. Kafka and ActiveMQ realms are refused
(1011) until their transports exist.

| Env | Default | Meaning |
|---|---|---|
| `WSPA_MONGODB` | – | ws-pubsub-admin's MongoDB (a read-only user is enough). Unset: every realm uses the platform Redis. |
| `SECRETS_KEYS` | – | The admin's `kid:base64key,...`, to open backend passwords. |
| `WS_REALMS_STRICT` | `false` | Refuse realms that aren't registered. |
| `WS_REALM_CACHE` | `30s` | How often realm settings and the list of registered ids are refreshed. |

`WS_ALLOWED_ORIGINS` applies to platform and unregistered realms only.

## Known gaps

- **Users are not authenticated by the gateway.** Registered realms limit
  origins, but backends must authenticate users themselves.
- **Client frames are JSON-encoded Buffers** (one number per byte), several
  times the size of the frame.
- **`set_meta` can't remove keys** (e.g. on logout); backends overwrite them.
- `options.js` still carries `ezsso_*` settings that nothing uses.
