import Debug from 'debug';
const debug = Debug('anon-chat-pubsub:RedisStreams');

import redis, { createClient } from 'redis';
redis.debug_mode = true;

export default function RedisStreams(options) {
	const {group, consumer} = options;

    const uuid = crypto.randomUUID();

    const res_stream = `${options.redis_res_channel_prefix}${uuid}`;

    this.redis = createClient({
        socket: {
            host:       options.redis_host || 'localhost',
            port:       options.redis_port || 6379,
            family:     options.redis_family || 4
        },
        password:   options.redis_password,
        retry_strategy: (options) => {
            // Reconnect after a delay based on the attempt number
            return Math.min(options.attempt * 100, 3000);
        }
    });

	this.redis.connect();

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
				debug('Consumer group already exists');
			} else {
				throw err;
			}
		}
	};

    this.publish = async (realm, data) => {
        const stream = `${options.redis_req_channel_prefix}${realm}`;
		debug('pub', stream, data); 

        data.addr.topic = res_stream;
		const message = JSON.stringify(data);

		return this.redis.xAdd(stream, '*', message);
	};

    const callbacks = [];

    this.subscribe = async callback => {
        callbacks.push(callback);
    };

	const subscribe = async () => {
		await this.initStreamGroup(res_stream, group);

		this.redis.xReadGroup(group, consumer, { key: res_stream, id: '>' }, 1, async (err, streams) => {
			if (err) {
				debug('Error reading from stream:', err);
				return;
			}

			if (streams && streams.length > 0) {
				const messages = streams[0].messages;
				for (const message of messages) {
					const id = message.id;
					const data = JSON.parse(message.message);
					debug('Received message:', id, data);
					await Promise.all(callbacks.map(callback => callback(data)));

					// Acknowledge message
					this.redis.xAck(res_stream, group, id, (err) => {
						if (err) {
							debug('Error acknowledging message:', err);
						}
					});
				}
			}
		});
	};

	subscribe();
}

