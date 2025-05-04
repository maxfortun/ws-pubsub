import Debug from 'debug';
const debug = Debug('ws-pubsub:RedisPubSub');

import crypto			from 'crypto';
import { createClient }	from "redis";

export default function RedisPubSub(options) {
	const uuid = crypto.randomUUID();
	const channel = 'default';
	const req_topic = `${options.redis_req_channel_prefix}${channel}`;
	const res_topic = `${options.redis_res_channel_prefix}${channel}_${uuid}`;
	const callbacks = [];

	const pub = createClient({
		socket: {
			host:		options.redis_host || 'localhost',
			port:		options.redis_port || 6379,
			family:		options.redis_family || 4
		},
		password:	options.redis_password,
		retry_strategy: (options) => {
			// Reconnect after a delay based on the attempt number
			return Math.min(options.attempt * 100, 3000);
		}
	});

	const sub = pub.duplicate();

	pub.connect();
	sub.connect();

	this.publish = async data => {
		data.a.t = res_topic;
		const message = JSON.stringify(data);
		return pub.publish(options.redis_req_channel_prefix, message);
	};

	this.subscribe = async callback => {
		callbacks.push(callback);
	};

	sub.on('message', async (channel, message) => {
		debug(`RedisPubSub message from ${channel}: ${message}`);
		const data = JSON.parse(message);
		callbacks.forEach(callback => callback(data));
	});

	sub.subscribe(res_topic);
}

