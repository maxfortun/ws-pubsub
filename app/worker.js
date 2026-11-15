import Debug from 'debug';
const debug = Debug('ws-pubsub:main');

import { WebSocketServer }	from 'ws';

import { atob, rmEmptyValues } from './utils.js';

import options from './options.js';

import handlers from './handlers/index.js';

const sockets = {};

const header = (req, name) => {
	const value = req.headers[name];
	return typeof value === 'string' ? value.slice(0, 512) : undefined;
};

// The client's address: the X-Forwarded-For entry added by the outermost
// trusted proxy. Entries left of it are whatever the client sent.
export function clientIp(req, trustedHops) {
	const forwarded = (header(req, 'x-forwarded-for') || '').split(',').map(s => s.trim()).filter(Boolean);
	if(trustedHops > 0 && forwarded.length >= trustedHops) {
		return forwarded[forwarded.length - trustedHops];
	}
	return req.socket.remoteAddress;
}

export function connectionInfo(req, options) {
	return {
		ip: clientIp(req, options.trusted_proxy_hops),
		origin: header(req, 'origin'),
		user_agent: header(req, 'user-agent'),
		accept_language: header(req, 'accept-language'),
		// Global Privacy Control: a legally binding opt-out in some places (CPRA)
		gpc: header(req, 'sec-gpc') === '1',
		ua_mobile: header(req, 'sec-ch-ua-mobile'),
		ua_platform: header(req, 'sec-ch-ua-platform'),
	};
}

export default async function worker(workerId) {
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
		sockets[uuid] = socket;

		debug(workerId, uuid, 'open', Object.keys(sockets).length);

		// Facts about the connection, from the request itself only (never from
		// subprotocol values, which the client chooses). Sent once, on open.
		const conn = connectionInfo(req, options);

		if(options.allowed_origins.length && !options.allowed_origins.includes(conn.origin)) {
			debug(workerId, uuid, 'origin not allowed', conn.origin);
			delete sockets[uuid];
			socket.close(1008, 'Origin not allowed');
			return;
		}

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

		const getValidRealm = socket => {
			const realm = socket.custom.headers['ws-realm'];

			if(!realm) {
				socket.send(JSON.stringify({ error: 'Missing realm' }));
				return null;
			}

			// Integrate realm provisioning and check in db if realm is allowed
			/*
			if(!isRealmAuthorized(socket, realm)) {
				socket.send(JSON.stringify({ error: 'Unauthorized realm', realm }));
				return null;
			}
			*/

			return realm;
		};

		const realm = getValidRealm(socket);

		if(!realm) {
			socket.close(1008, 'Policy Violation');
			return;
		}

		const publish = message => {
			// const sanitized = rmEmptyValues(message);
			options.pubSub.publish(realm, message);
		};

		socket.on('close', event => {
			delete sockets[uuid];
			debug(workerId, uuid, 'close', Object.keys(sockets).length, event);
			publish({
				addr: { ws: uuid },
				meta: socket.meta || {},
				wsctl: 'close'
			});
		});

		socket.on('error', event => {
			debug(workerId, uuid, 'error', event);
		});

		// Maybe add crypto key to socket addr to prevent spoofing?
		socket.on('message', (message, isBinary) => {
			publish({
				addr: { ws: uuid },
				meta: socket.meta || {},
				message,
				isBinary
			});
		});

		publish({
			addr: { ws: uuid },
			conn,
			meta: socket.meta || {},
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

