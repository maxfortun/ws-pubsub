import Debug from 'debug';
const debug = Debug('ws-pubsub:main');

import { WebSocketServer }	from 'ws';

import { atob, rmEmptyValues, stringify } from './utils.js';

import options from './options.js';

import handlers from './handlers/index.js';

const sockets = {};

export default function worker(workerId) {
	const host = '0.0.0.0';
	const port = process.env.PORT || 3000;
	const path = options.ws_path;

	const webSocketServer = new WebSocketServer({ 
		host,
		port,
		path
	}, () => {
		debug(workerId, 'Started WebSocket worker on', host, port, path);
	});

	webSocketServer.on('connection', (socket, req) => {
		const uuid = crypto.randomUUID();
		debug(workerId, uuid, 'New connection');

		sockets[uuid] = socket;

		socket.custom = {
			protocols: [],
			headers: {}
		};

		if(socket.protocol) {
			// Protocol needs to have a realm specified. We'd need to validate it
			const rawProtocols = socket.protocol.split(/\s*[,;]\s*/);
			// debug(workerId, uuid, 'raw protocols', rawProtocols);

			rawProtocols.forEach(protocol => {
				try {
					const decoded = atob(protocol);
					// debug(workerId, uuid, 'protocol decoded', decoded);
					const match = decoded.match(/^([^:]+):\s*(.*)$/);
					if(!match) {
						socket.custom.protocols.push(protocol);
						return;
					}
					// debug(workerId, uuid, 'protocol match', match);
					socket.custom.headers[match[1]] = match[2];
				} catch(e) {
					debug(workerId, uuid, 'protocol error', protocol, e);
				}
			});
		}

		debug(workerId, uuid, 'custom', socket.custom);

		const realm = socket.custom.headers['ws-realm'] || 'dlq';

		const publish = message => {
			const sanitized = rmEmptyValues(message);
			debug(workerId, uuid, 'pub', sanitized);
			options.pubSub.publish(realm, sanitized);
		};

		socket.on('close', event => {
			debug(workerId, uuid, 'close', event);
			delete sockets[uuid];
			publish({
				a: { s: uuid },
				md: socket.meta,
				sc: 'c'
			});
		});

		socket.on('error', event => {
			debug(workerId, uuid, 'error', event);
		});

		// Maybe add crypto key to socket addr to prevent spoofing?
		socket.on('message', event => {
			publish({
				a: { s: uuid },
				md: socket.meta,
				m: event.toString()
			});
		});

		options.pubSub.subscribe(data => {
			const socket = sockets[data.a.s];

			// data.m == message
			if(data.m) {
				debug(workerId, data.a.s, 'sub', data);
				const message = stringify(data.m);
				socket.send(message);
			}

			if(data.sc) {
				// data.sc == socket control
				const handler = handlers[data.sc];
				if(handler) {
					handler({socket, data});
				} else {
					debug(workerId, data.a.s, 'Unknown socket control:', data.sc);
				}
			}
		});

		publish({
			a: { s: uuid },
			md: socket.meta,
			sc: 'o'
		});
	});
}

