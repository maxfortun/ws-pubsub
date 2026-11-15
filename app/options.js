import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' })

import RedisStreams from './pubsub/RedisStreams.js';

const redisSentinels = (process.env.REDIS_SENTINELS || "").split(/\s*,\s*/).filter(s => s).map(sentinel => {
	const [ host, port ] = sentinel.split(/:/);
	return {host, port: parseInt(port || '26379')};
});

const pubSub = new RedisStreams({
	redis_sentinels: redisSentinels.length ? redisSentinels : undefined,
	redis_host: process.env.REDIS_HOST,
	redis_port: process.env.REDIS_PORT,
	redis_password: process.env.REDIS_PASSWORD,
	redis_sentinel_password: process.env.REDIS_PASSWORD,
	redis_req_channel_prefix: 'ws-' + process.env.ENV + '.req.',
	redis_res_channel_prefix: 'ws-' + process.env.ENV + '.res.',
	group: 'ws-pubsub-' + process.env.ENV,
	consumer: 'ws-pubsub-' + process.env.ENV,
});

export default {
	ezsso_oidc_auth_id: process.env.EZSSO_OIDC_AUTH_ID,
	ezsso_oidc_idp_id: process.env.EZSSO_OIDC_IDP_ID,
	ezsso_oidc_authorize_uri: process.env.EZSSO_OIDC_AUTHORIZE_URI,
	ezsso_oidc_logout_uri: process.env.EZSSO_OIDC_LOGOUT_URI,
	ezsso_client_fetch_timeout: 5000,
	// Proxies in front of the gateway that append to X-Forwarded-For
	// (e.g. 1 for the Istio ingress gateway); the client is the entry they added
	trusted_proxy_hops: parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10),
	// Pages allowed to open sockets: comma-separated origins. Browsers don't
	// stop other sites from opening a websocket with the user's cookies.
	allowed_origins: (process.env.WS_ALLOWED_ORIGINS || '').split(/\s*,\s*/).filter(Boolean),
	pubSub
};
