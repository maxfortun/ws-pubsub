import Debug from 'debug';
const debug = Debug('ws-pubsub:main');

import { WebSocketServer }	from 'ws';

import { atob, rmEmptyValues } from './utils.js';

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

	webSocketServer.on('connection', socket => {
		const uuid = crypto.randomUUID();
		sockets[uuid] = socket;

		debug(workerId, uuid, 'open', Object.keys(sockets).length);

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
			options.pubSub.publish(realm, sanitized);
		};

		socket.on('close', event => {
			delete sockets[uuid];
			debug(workerId, uuid, 'close', Object.keys(sockets).length, event);
			publish({
				addr: { ws: uuid },
				meta: socket.meta,
				wsctl: 'close'
			});
		});

		socket.on('error', event => {
			debug(workerId, uuid, 'error', event);
		});

		// Maybe add crypto key to socket addr to prevent spoofing?
		socket.on('message', event => {
			publish({
				addr: { ws: uuid },
				meta: socket.meta,
				message: event.toString()
			});
		});

		publish({
			addr: { ws: uuid },
			meta: socket.meta,
			wsctl: 'open'
		});
	});

	options.pubSub.subscribe(data => {
		const socket = sockets[data?.addr?.ws];
		if(!socket) {
			return;
		}

		// data.m == message
		if(data.message) {
			debug(workerId, data.addr.ws, 'sub', data);
			socket.send(data.message);
		}

		if(data.wsctl) {
			const handler = handlers[data.wsctl];
			if(handler) {
				handler({socket, data});
			} else {
				debug(workerId, data.addr.wsctl, 'Unknown socket control:', data.wsctl);
			}
		}
	});
}

