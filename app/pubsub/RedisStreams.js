import Debug from 'debug';
const debug = Debug('ws-pubsub:RedisStreams');

import { createClient, createSentinel } from 'redis';
import { trimOlderThan } from './ttl.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// How long a blocking read waits before looping (also how long a stopped
// subscription may take to notice, at most)
const BLOCK_MS = 5000;

/**
 * Redis Streams transport. Used for the platform Redis (options from the
 * environment) and for each registered realm's own Redis.
 *
 * options: redis_host, redis_port, redis_password, redis_username, redis_db,
 *   redis_tls ({ ca, cert, key } or true), redis_sentinels, redis_master,
 *   redis_sentinel_password, redis_req_channel_prefix,
 *   redis_res_channel_prefix, group, consumer, gateway_id, realm_ttl,
 *   response_ttl, subscribe_platform (default true)
 */
export default function RedisStreams(options) {
	const { group, consumer } = options;
	const maxRetryDelay = options.maxRetryDelay || 30000;

	// The gateway process: {gateway} in topic names
	const uuid = options.gateway_id || crypto.randomUUID();
	this.gateway_id = uuid;

	const res_stream = `${options.redis_res_channel_prefix}${uuid}`;

	const createRedisClient = () => {
		const tls = options.redis_tls ? { tls: true, ...(typeof options.redis_tls === 'object' && options.redis_tls) } : {};
		if(options.redis_sentinels) {
			const params = {
				name: options.redis_master || 'mymaster',
				sentinelRootNodes: options.redis_sentinels,
				sentinelClientOptions: {
					password: options.redis_sentinel_password,
				},
				nodeClientOptions: {
					username: options.redis_username,
					password: options.redis_password,
					database: options.redis_db,
					socket: tls,
				},
			};
			const client = createSentinel(params);
			client.on('error', err => debug('Redis Sentinel error:', err.message || err));
			return client;
		}
		const params = {
			socket: {
				host: options.redis_host || 'localhost',
				port: options.redis_port || 6379,
				family: options.redis_family || 4,
				reconnectStrategy: attempt => Math.min(attempt * 100, maxRetryDelay),
				...tls,
			},
			username: options.redis_username,
			password: options.redis_password,
			database: options.redis_db,
		};
		debug('createRedis:', { ...params, password: params.password && '[redacted]' });
		const client = createClient(params);
		client.on('error', err => debug('Redis client error:', err.message || err));
		return client;
	};

	// Connects with retries; resolves once connected
	const connect = async client => {
		let attempt = 0;
		while(true) {
			attempt++;
			try {
				await client.connect();
				return client;
			} catch(err) {
				const delay = Math.min(attempt * 1000, maxRetryDelay);
				debug('Connection failed (attempt %d), retrying in %dms: %s', attempt, delay, err.message || err);
				await sleep(delay);
				if(closed) throw new Error('closed');
			}
		}
	};

	let closed = false;
	this._redis = null;

	// The connection for publishing and acks (never blocked)
	this.redis = async () => {
		if(this._redis?.isOpen) {
			return this._redis;
		}
		if(this._redis) {
			try { await this._redis.disconnect(); } catch {}
		}
		this._redis = createRedisClient();
		return connect(this._redis);
	};

	// Platform requests: ws-<ENV>.req.<realm>, replies to this process's stream
	this.publish = async (realm, data) => {
		const stream = `${options.redis_req_channel_prefix}${realm}`;
		data.addr.topic = res_stream;
		return this.publishTo(stream, data, options.realm_ttl(realm));
	};

	// Requests live for their TTL: each entry carries `exp` (for backends
	// that check it) and every write trims the stream by age
	this.publishTo = async (stream, data, ttl) => {
		const now = Date.now();
		data.exp = now + ttl;
		debug('pub', stream, data);
		return (await this.redis()).xAdd(stream, '*', { message: JSON.stringify(data) }, trimOlderThan(ttl, now));
	};

	// Reply streams this process reads: trimmed to response_ttl, and given a
	// key expiry refreshed while the process runs - a stopped process's
	// streams delete themselves
	const responseTtl = options.response_ttl || 60000;
	const replyStreams = new Set();
	const maintainReplyStreams = async () => {
		for(const stream of replyStreams) {
			try {
				const redis = await this.redis();
				await redis.xTrim(stream, 'MINID', `${Date.now() - responseTtl}-0`);
				await redis.pExpire(stream, Math.max(responseTtl * 5, 5 * 60000));
			} catch(err) {
				debug('Reply stream maintenance failed:', stream, err.message || err);
			}
		}
	};
	const maintenance = setInterval(maintainReplyStreams, Math.max(1000, Math.min(responseTtl, 30000)));
	maintenance.unref?.();

	/**
	 * Read `stream` (as this process's consumer group) and call
	 * callback(data) for each entry. Returns stop(). Each subscription has
	 * its own connection, because a blocking read occupies it.
	 */
	this.subscribeStream = (stream, callback) => {
		let stopped = false;
		let reader = null;
		replyStreams.add(stream);

		(async () => {
			let errorCount = 0;
			let groupReady = false;
			debug('subscribe:', stream, group, consumer);
			while(!stopped && !closed) {
				try {
					if(!reader?.isOpen) {
						reader = createRedisClient();
						await connect(reader);
					}
					if(!groupReady) {
						try {
							await reader.xGroupCreate(stream, group, '0', { MKSTREAM: true });
						} catch(err) {
							if(!String(err?.message).includes('BUSYGROUP')) throw err;
						}
						groupReady = true;
						await maintainReplyStreams();
					}
					const streams = await reader.xReadGroup(group, consumer, [{ key: stream, id: '>' }], { COUNT: 100, BLOCK: BLOCK_MS });
					errorCount = 0;
					for(const s of streams || []) {
						for(const { id, message } of s.messages) {
							try {
								const data = JSON.parse(message.message);
								debug('sub', stream, data);
								callback(data);
							} catch(err) {
								debug('Bad message on', stream, err.message);
							}
							await reader.xAck(stream, group, id);
						}
					}
				} catch(err) {
					if(stopped || closed) break;
					errorCount++;
					const delay = Math.min(errorCount * 1000, maxRetryDelay);
					debug('Error reading %s (attempt %d), retrying in %dms: %s', stream, errorCount, delay, err.message || err);
					// The stream or group may be gone (expired, deleted): recreate it
					groupReady = false;
					try { await reader?.disconnect(); } catch {}
					reader = null;
					await sleep(delay);
				}
			}
			try { await reader?.disconnect(); } catch {}
		})();

		return () => {
			stopped = true;
			replyStreams.delete(stream);
			// Interrupts the blocking read
			reader?.disconnect().catch(() => {});
		};
	};

	this.close = async () => {
		closed = true;
		clearInterval(maintenance);
		for(const stream of replyStreams) replyStreams.delete(stream);
		try { await this._redis?.disconnect(); } catch {}
	};

	// Platform replies for this process
	const callbacks = [];
	this.subscribe = async callback => {
		callbacks.push(callback);
	};
	if(options.subscribe_platform !== false) {
		this.subscribeStream(res_stream, data => callbacks.forEach(callback => callback(data)));
	}
}
