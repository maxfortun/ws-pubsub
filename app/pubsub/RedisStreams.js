import Debug from 'debug';
const debug = Debug('ws-pubsub:RedisStreams');

import redis, { createClient, createSentinel } from 'redis';
redis.debug_mode = true;

export default function RedisStreams(options) {
	const {group, consumer} = options;

	const uuid = crypto.randomUUID();

	const res_stream = `${options.redis_res_channel_prefix}${uuid}`;

    // { host: SENTINEL_SERVICE, port: SENTINEL_PORT }
	if(options.redis_sentinels) {
		const params = {
			name: options.redis_master || 'mymaster',
			sentinelRootNodes: options.redis_sentinels,
			password: options.redis_password,
			sentinelPassword: options.redis_sentinel_password
		};
		debug('createSentinel', params);
		this.redis = createSentinel(params);
	} else {
		const params = {
			socket: {
				host: options.redis_host || 'localhost',
				port: options.redis_port || 6379,
				family: options.redis_family || 4
			},
			password:   options.redis_password,
			retry_strategy: (options) => {
				// Reconnect after a delay based on the attempt number
				return Math.min(options.attempt * 100, 3000);
			}
		};
		debug('createClient', params);
		this.redis = createClient(params);
	}

	this.connect = async () => {
		debug('Connecting');
		const result = await this.redis.connect();
		debug('Connected');
		return result;
	};

	this.publish = async (realm, data) => {
		const stream = `${options.redis_req_channel_prefix}${realm}`;
		data.addr.topic = res_stream;
		debug('pub', stream, data); 
		const message = JSON.stringify(data);
		return this.redis.xAdd(stream, '*', { message });
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
			const result = await this.redis.xGroupCreate(stream, group, '0', { MKSTREAM: true });
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
		const streams = await this.redis.xReadGroup(group, consumer, [ { key: stream, id: '>' } ], { COUNT: 1 });

		if (!streams || !streams.length) {
			return;
		}

		for (const _stream of streams) {
			for(const { id, message } of _stream.messages) {
				const data = JSON.parse(message.message);
				debug('sub', stream, data);
				callback(data);
				await this.redis.xAck(stream, group, id);
			}
		}
	};

	this._subscribe = async (stream, callback) => {
		await this.initStreamGroup(stream, group);

		debug('subscribe:', stream, group, consumer);
		while(true) {
			try {
				await this.readGroup(stream, callback);
			} catch(e) {
				debug('Error reading stream:', stream, group, consumer, e);
			}
		}
	};

	this._subscribe(res_stream, data => callbacks.forEach(callback => callback(data)));
}

