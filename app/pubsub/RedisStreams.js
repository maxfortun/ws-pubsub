import Debug from 'debug';
const debug = Debug('ws-pubsub:RedisStreams');

import redis, { createClient, createSentinel } from 'redis';
redis.debug_mode = true;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export default function RedisStreams(options) {
	const {group, consumer} = options;
	const maxRetryDelay = options.maxRetryDelay || 30000;

	const uuid = crypto.randomUUID();

	const res_stream = `${options.redis_res_channel_prefix}${uuid}`;

	const createRedisClient = () => {
		if(options.redis_sentinels) {
			const params = {
				name: options.redis_master || 'mymaster',
				sentinelRootNodes: options.redis_sentinels,
				sentinelClientOptions: {
					password: options.redis_sentinel_password
				},
				nodeClientOptions: {
					password: options.redis_password
				},
			};
			const client = createSentinel(params);
			client.on('error', err => debug('Redis Sentinel error:', err.message || err));
			return client;
		} else {
			const params = {
				socket: {
					host: options.redis_host || 'localhost',
					port: options.redis_port || 6379,
					family: options.redis_family || 4,
					reconnectStrategy: attempt => Math.min(attempt * 100, maxRetryDelay)
				},
				password: options.redis_password,
			};
			debug('createRedis:', params);
			const client = createClient(params);
			client.on('error', err => debug('Redis client error:', err.message || err));
			return client;
		}
	};

	this._redis = null;
	this.connectPromise = null;

	this.redis = async () => {
		if (this._redis && this._redis.isOpen) {
			return this._redis;
		}

		let attempt = 0;
		while (true) {
			attempt++;
			try {
				if (this._redis) {
					try { await this._redis.disconnect(); } catch (_) {}
				}
				this._redis = createRedisClient();
				debug('Connecting (attempt %d)', attempt);
				await this._redis.connect();
				debug('Connected');
				return this._redis;
			} catch (err) {
				const delay = Math.min(attempt * 1000, maxRetryDelay);
				debug('Connection failed (attempt %d), retrying in %dms: %s', attempt, delay, err.message || err);
				await sleep(delay);
			}
		}
	};

	this.publish = async (realm, data) => {
		const stream = `${options.redis_req_channel_prefix}${realm}`;
		data.addr.topic = res_stream;
		debug('pub', stream, data); 
		const message = JSON.stringify(data);
		return (await this.redis()).xAdd(stream, '*', { message });
	};

	const callbacks = [];

	this.subscribe = async callback => {
		callbacks.push(callback);
	};

	const streamGroups = {};

	this.initStreamGroup = async (stream, group) => {
		if(!streamGroups[stream]) {
			streamGroups[stream] = { groups: {} };
		}

		if(streamGroups[stream].groups[group]) {
			return;
		}

		try {
			const result = await (await this.redis()).xGroupCreate(stream, group, '0', { MKSTREAM: true });
			streamGroups[stream].groups[group] = true;
			debug('Stream group created:', stream, group, result);
			return result;
		} catch (err) {
			if (err.message.includes('BUSYGROUP')) {
				streamGroups[stream].groups[group] = true;
				debug('Consumer group already exists', stream, group);
			} else {
				throw err;
			}
		}
	};

	this.readGroup = async (stream, callback) => {
		const streams = await (await this.redis()).xReadGroup(group, consumer, [ { key: stream, id: '>' } ], { COUNT: 1 });

		if (!streams || !streams.length) {
			return;
		}

		for (const _stream of streams) {
			for(const { id, message } of _stream.messages) {
				const data = JSON.parse(message.message);
				debug('sub', stream, data);
				callback(data);
				await (await this.redis()).xAck(stream, group, id);
			}
		}
	};

	this._subscribe = async (stream, callback) => {
		let errorCount = 0;

		debug('subscribe:', stream, group, consumer);
		while(true) {
			try {
				await this.initStreamGroup(stream, group);
				await this.readGroup(stream, callback);
				errorCount = 0;
			} catch(e) {
				errorCount++;
				const delay = Math.min(errorCount * 1000, maxRetryDelay);
				debug('Error reading stream (attempt %d), retrying in %dms: %s', errorCount, delay, e.message || e);
				this._redis = null;
				await sleep(delay);
			}
		}
	};

	this._subscribe(res_stream, data => callbacks.forEach(callback => callback(data)));
}

