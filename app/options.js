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
	pubSub
};
