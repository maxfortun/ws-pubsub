import Debug from 'debug';
const debug = Debug('ws-pubsub:realms:router');

import RedisStreams from '../pubsub/RedisStreams.js';
import { renderTemplate } from './topics.js';
import { RegistryUnavailable } from './admin-registry.js';

/** Refusal with a WebSocket close code and a client-safe reason */
export class RouteError extends Error {
	constructor(code, reason) {
		super(reason);
		this.code = code;
	}
}

const hostPort = text => {
	const i = text.lastIndexOf(':');
	return { host: text.slice(0, i), port: Number(text.slice(i + 1)) };
};

// A realm's Redis Streams backend settings -> RedisStreams options
function redisOptions(realm, secrets) {
	const c = realm.backend.config || {};
	const tls = c.tls ? {
		...(c.tls_ca && { ca: c.tls_ca }),
		...(c.tls_cert && { cert: c.tls_cert }),
		...(secrets.tls_key && { key: secrets.tls_key }),
	} : null;
	return {
		...(c.mode === 'sentinel'
			? { redis_sentinels: (c.sentinels || []).map(hostPort), redis_master: c.master_name || 'mymaster', redis_sentinel_password: secrets.password }
			: { redis_host: c.host, redis_port: c.port || 6379 }),
		redis_db: c.db || 0,
		redis_username: c.username || undefined,
		redis_password: secrets.password,
		redis_tls: tls && (Object.keys(tls).length ? tls : true),
	};
}

/**
 * Routes connections to the platform Redis or to their registered realm's
 * backend. route() resolves to
 *   { publish(data), release(), limits, realm? }
 * or throws RouteError.
 *
 * Without a registry every realm uses the platform. With one, realms not
 * registered in it use the platform unless strict (or there is no
 * platform: agent mode). Connections to registered realms are also
 * confirmed with admin (registry.check).
 *
 * options: registry (or null), platform (RedisStreams, or null), strict,
 *   allowedOrigins (for platform realms), env, gatewayId, group,
 *   consumer, responseTtl, onReply(data)
 */
export function createRouter(options) {
	const { registry, platform, strict, allowedOrigins, env, gatewayId, onReply } = options;
	const transports = new Map(); // "<realm>:<revision>" -> { streams, refs, subs: Map(topic -> { stop, refs }) }

	const transportFor = (realm, secrets) => {
		const key = `${realm.id}:${realm.revision}`;
		let t = transports.get(key);
		if(!t) {
			t = {
				key,
				refs: 0,
				subs: new Map(),
				streams: new RedisStreams({
					...redisOptions(realm, secrets),
					group: options.group,
					consumer: options.consumer,
					gateway_id: gatewayId,
					response_ttl: options.responseTtl,
					subscribe_platform: false,
				}),
			};
			transports.set(key, t);
			debug('transport for', key);
		}
		t.refs++;
		return t;
	};

	const subscribeReplies = (t, topic) => {
		let sub = t.subs.get(topic);
		if(!sub) {
			sub = { refs: 0, stop: t.streams.subscribeStream(topic, onReply) };
			t.subs.set(topic, sub);
		}
		sub.refs++;
	};

	const release = (t, topic) => {
		const sub = t.subs.get(topic);
		if(sub && --sub.refs === 0) {
			sub.stop();
			t.subs.delete(topic);
		}
		if(--t.refs === 0) {
			transports.delete(t.key);
			t.streams.close();
			debug('transport closed', t.key);
		}
	};

	const platformRoute = (realmId, origin) => {
		if(!platform) {
			throw new RouteError(1008, 'Unknown realm');
		}
		if(allowedOrigins.length && !allowedOrigins.includes(origin)) {
			throw new RouteError(1008, 'Origin not allowed');
		}
		return { publish: data => platform.publish(realmId, data), release: () => {}, limits: null };
	};

	return {
		async route(realmId, { origin, headers, conn = {} }) {
			if(!registry) {
				return platformRoute(realmId, origin);
			}

			let entry;
			try {
				entry = await registry.get(realmId);
			} catch(err) {
				// Registry down and the realm not cached: a realm that was
				// registered is never sent elsewhere. Not known to be
				// registered (or no id list loaded yet): as without a
				// registry, unless strict.
				if(err instanceof RegistryUnavailable && err.registered !== true && !strict && platform) {
					debug('registry unavailable, platform for', realmId);
					return platformRoute(realmId, origin);
				}
				throw new RouteError(1011, 'Realm registry unavailable, try again');
			}
			if(!entry) {
				if(strict || !platform) {
					throw new RouteError(1008, 'Unknown realm');
				}
				return platformRoute(realmId, origin);
			}

			const { realm, secrets, error } = entry;
			if(realm.status !== 'enabled') {
				throw new RouteError(1008, 'Realm is disabled');
			}
			if(error) {
				throw new RouteError(1011, error);
			}
			if(!(realm.allowed_origins || []).includes(origin)) {
				throw new RouteError(1008, 'Origin not allowed');
			}
			if(realm.backend?.type !== 'redis_streams') {
				throw new RouteError(1011, `Backend ${realm.backend?.type} is not supported by this gateway yet`);
			}

			let requestTopic, replyTopic;
			try {
				const ctx = { realm: realm.id, env, gateway: gatewayId, headers };
				requestTopic = renderTemplate(realm.topics.request, ctx);
				replyTopic = renderTemplate(realm.topics.reply, ctx);
			} catch(err) {
				throw new RouteError(1008, err.message);
			}

			// Admin has the last word on each connection
			if(registry.check) {
				const verdict = await registry.check(realm.id, { origin, headers, ip: conn.ip, user_agent: conn.user_agent });
				if(!verdict.allow) {
					throw new RouteError(verdict.code || 1008, verdict.reason || 'Refused');
				}
				if(verdict.unchecked) {
					debug('admin unreachable, allowed on local settings:', realm.id);
				}
			}

			const t = transportFor(realm, secrets);
			subscribeReplies(t, replyTopic);
			let released = false;
			return {
				realm,
				limits: realm.limits || null,
				publish: data => {
					data.addr.topic = replyTopic;
					return t.streams.publishTo(requestTopic, data, realm.ttl_ms);
				},
				release: () => {
					if(!released) {
						released = true;
						release(t, replyTopic);
					}
				},
			};
		},
	};
}
