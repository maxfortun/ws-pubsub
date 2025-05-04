import Debug from 'debug';
const debug = Debug('ws-pubsub:lib:RedisPubSub');

import crypto			from 'crypto';
import { createClient }	from "redis";

export default async function RedisPubSub(options) {
	const uuid = crypto.randomUUID();
	const reply_topic = `${options.redis_res_channel_prefix}$uuid`;
	const callbacks = [];

	const pub = createClient({
		socket: {
			host:		options.redis_host || 'localhost',
			port:		options.redis_port || 6379,
			family:		options.redis_family || 4
		},
		password:	options.redis_password,
		retry_strategy: (options) => {
			// If a connection attempt results in an error
			if (options.error && options.error.code === 'ECONNREFUSED') {
				// Stop reconnecting if the connection is refused
				return new Error('The server refused the connection');
			}

			// If the total retry time exceeds a limit
			if (options.total_retry_time > 1000 * 60 * 60) {
				// Stop reconnecting after one hour
				return new Error('Retry time exhausted');
			}

			// If the number of attempts exceeds a limit
			if (options.attempt > 10) {
				// Stop reconnecting after 10 attempts
				return undefined;
			}

			// Reconnect after a delay based on the attempt number
			return Math.min(options.attempt * 100, 3000);
		}
	});

	const sub = pub.duplicate();

	pub.connect();
	sub.connect();

	this.publish = async data => {
		data.a.t = reply_topic;
		const message = JSON.stringify(data);
		return pub.publish(options.redis_req_channel_name, message);
	};

	this.subscribe = async callback => {
		callbacks.push(callback);
	};

	sub.on('message', async (channel, message) => {
		debug(`RedisPubSub message from ${channel}: ${message}`);
		const data = JSON.parse(message);
		callbacks.forEach(callback => callback(data));
	});

	sub.subscribe(reply_topic);
}

