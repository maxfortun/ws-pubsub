import Debug from 'debug';
const debug = Debug('ws-pubsub:main');

import { WebSocketServer }	from 'ws';

import { atob } from './utils.js';

import options from './options.js';

import handlers from './handlers/index.js';
import { createRouter, RouteError } from './realms/router.js';
import { encodeFrame } from './pubsub/frames.js';

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

	// Replies from realm backends are delivered like platform replies
	const router = createRouter({ ...options.routing, platform: options.pubSub, onReply: data => deliver(data) });

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

		socket.custom = {
			protocols: [],
			headers: {}
		};

		// Subprotocols carry the client's parameters as base64("name: value").
		// All of them are in the request header; socket.protocol is only the
		// one the server selected.
		const offered = req.headers['sec-websocket-protocol'] || socket.protocol;
		if(offered) {
			const rawProtocols = offered.split(/\s*[,;]\s*/).filter(Boolean);
			rawProtocols.forEach(protocol => {
				try {
					const decoded = atob(protocol);
					const match = decoded.match(/^([^:]+):\s*(.*)$/);
					if(!match) {
						socket.custom.protocols.push(protocol);
						return;
					}
					socket.custom.headers[match[1]] = match[2];
				} catch(e) {
					debug(workerId, uuid, 'protocol error', protocol, e);
				}
			});
		}

		debug(workerId, uuid, 'custom', socket.custom);

		const realm = socket.custom.headers['ws-realm'];
		if(!realm) {
			socket.send(JSON.stringify({ error: 'Missing realm' }));
			delete sockets[uuid];
			socket.close(1008, 'Policy Violation');
			return;
		}

		// Header names are case-insensitive; topic templates use lower case
		const headers = Object.fromEntries(Object.entries(socket.custom.headers).map(([k, v]) => [k.toLowerCase(), v]));

		// Routing may need a registry lookup: queue messages until it's done
		const routed = router.route(realm, { origin: conn.origin, headers, conn });
		let route = null;
		let refused = false;
		routed.then(r => { route = r; }, err => {
			refused = true;
			debug(workerId, uuid, 'refused', realm, err.message);
			delete sockets[uuid];
			socket.close(err instanceof RouteError ? err.code : 1011, err instanceof RouteError ? err.message : 'Internal error');
		});

		const publish = async message => {
			try {
				const r = route || await routed;
				await r.publish(message);
			} catch(err) {
				if(!refused) debug(workerId, uuid, 'publish failed', err.message || err);
			}
		};

		socket.on('close', event => {
			delete sockets[uuid];
			debug(workerId, uuid, 'close', Object.keys(sockets).length, event);
			if(refused) return;
			publish({
				addr: { ws: uuid },
				meta: socket.meta || {},
				wsctl: 'close'
			}).finally(() => route?.release());
		});

		socket.on('error', event => {
			debug(workerId, uuid, 'error', event);
		});

		socket.on('message', async (message, isBinary) => {
			const r = route || await routed.catch(() => null);
			if(!r) return;
			const limits = r.limits;
			if(limits) {
				if(isBinary && !limits.allow_binary) {
					socket.send(JSON.stringify({ error: 'Binary messages are not allowed in this realm' }));
					return;
				}
				if(message.length > limits.max_message_bytes) {
					socket.send(JSON.stringify({ error: 'Message too large', max_bytes: limits.max_message_bytes }));
					return;
				}
			}
			publish({
				addr: { ws: uuid },
				meta: socket.meta || {},
				...encodeFrame(message, isBinary, r.realm || socket.custom.accepts?.includes('base64') ? 'base64' : 'buffer'),
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

	function deliver(data) {
		const socket = sockets[data?.addr?.ws];
		if(!socket) {
			return;
		}

		// What this connection's backend reads, e.g. accepts: ['base64'] in
		// its reply to open: kept on the socket for its later frames
		if(Array.isArray(data.accepts)) {
			socket.custom.accepts = data.accepts.filter(a => typeof a === 'string');
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
	}
	options.pubSub?.subscribe(deliver);
}

