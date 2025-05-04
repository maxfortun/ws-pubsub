import Debug from "debug";
const debug = Debug("ws-pubsub:options");

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' })

import RedisPubSub from './RedisPubSub.js';

const pubSub = RedisPubSub({
	redis_host: process.env.REDIS_HOST,
	redis_password: process.env.REDIS_PASSWORD,
	redis_req_channel_name: 'req_',
	redis_res_channel_prefix: 'res_'
});

export default {
	ezsso_oidc_auth_id: process.env.EZSSO_OIDC_AUTH_ID,
	ezsso_oidc_idp_id: process.env.EZSSO_OIDC_IDP_ID,
	ezsso_oidc_authorize_uri: process.env.EZSSO_OIDC_AUTHORIZE_URI,
	ezsso_oidc_logout_uri: process.env.EZSSO_OIDC_LOGOUT_URI,
	ezsso_client_fetch_timeout: 5000,
	pubSub
};
