import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' })

import RedisStreams from './pubsub/RedisStreams.js';
import { parseDuration, realmTtls } from './pubsub/ttl.js';
import { createAdminRegistry, loadLocalRealms } from './realms/admin-registry.js';

const list = value => String(value || '').split(/\s*,\s*/).filter(Boolean);

// hosted: the platform gateway, with the platform Redis for realms not
// registered in ws-pubsub-admin. agent: runs next to a customer's brokers,
// registered realms only.
const MODE = process.env.WS_MODE || 'hosted';
if(!['hosted', 'agent'].includes(MODE)) {
	throw new Error(`WS_MODE must be hosted or agent, not ${MODE}`);
}
if(MODE === 'agent' && !(process.env.WSPA_URL && process.env.WSPA_TOKEN)) {
	throw new Error('Agent mode needs WSPA_URL and WSPA_TOKEN');
}
const ENV = process.env.ENV || 'prod';
const gatewayId = crypto.randomUUID();
const responseTtl = parseDuration(process.env.WS_RESPONSE_TTL || '1m');

const redisSentinels = (process.env.REDIS_SENTINELS || "").split(/\s*,\s*/).filter(s => s).map(sentinel => {
	const [ host, port ] = sentinel.split(/:/);
	return {host, port: parseInt(port || '26379')};
});

const pubSub = MODE === 'hosted' ? new RedisStreams({
	redis_sentinels: redisSentinels.length ? redisSentinels : undefined,
	redis_host: process.env.REDIS_HOST,
	redis_port: process.env.REDIS_PORT,
	redis_password: process.env.REDIS_PASSWORD,
	redis_sentinel_password: process.env.REDIS_PASSWORD,
	redis_req_channel_prefix: 'ws-' + ENV + '.req.',
	redis_res_channel_prefix: 'ws-' + ENV + '.res.',
	group: 'ws-pubsub-' + ENV,
	consumer: 'ws-pubsub-' + ENV,
	gateway_id: gatewayId,
	// How long a request waits for its realm's backend before it is dropped
	realm_ttl: realmTtls(process.env.WS_REALM_TTLS, parseDuration('1h'), console.warn),
	// Replies older than this are useless (the socket's request is long gone)
	response_ttl: responseTtl,
}) : null;

// Realms registered in ws-pubsub-admin, over its agent API (never its
// database). Without WSPA_URL (hosted only) every realm uses the platform
// Redis, as before.
const registry = process.env.WSPA_URL
	? createAdminRegistry({
		url: process.env.WSPA_URL,
		token: process.env.WSPA_TOKEN,
		local: loadLocalRealms(process.env.WS_LOCAL_REALMS_FILE),
		gatewayId,
		version: process.env.WS_VERSION,
		checkTimeoutMs: parseDuration(process.env.WS_ADMIN_CHECK_TIMEOUT || '3s'),
		requireCheck: process.env.WS_ADMIN_CHECK_REQUIRED === 'true',
	})
	: null;

export default {
	// Proxies in front of the gateway that append to X-Forwarded-For
	// (e.g. 1 for the Istio ingress gateway); the client is the entry they added
	trusted_proxy_hops: parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10),
	// Pages allowed to open sockets: comma-separated origins. Browsers don't
	// stop other sites from opening a websocket with the user's cookies.
	allowed_origins: list(process.env.WS_ALLOWED_ORIGINS),
	pubSub,
	mode: MODE,
	routing: {
		registry,
		platform: pubSub,
		// Refuse realms not registered in ws-pubsub-admin (otherwise they use
		// the platform Redis, as without a registry; agents always refuse them)
		strict: process.env.WS_REALMS_STRICT === 'true',
		// Origins allowed for platform realms (registered realms have their own)
		allowedOrigins: list(process.env.WS_ALLOWED_ORIGINS),
		env: ENV,
		gatewayId,
		group: 'ws-pubsub-' + ENV,
		consumer: 'ws-pubsub-' + ENV,
		responseTtl,
	},
};
