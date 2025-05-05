import Debug from 'debug';
const debug = Debug('ws-pubsub:main');

import cluster from 'node:cluster';
import { WebSocketServer }	from 'ws';

import { atob, rmEmptyValues } from './utils.js';

import options from './options.js';

const sockets = {};

const c = data => {
	debug('Backend requested connection close', data);
	const socket = sockets[data.a.s];
	socket.close();
};

const m = data => {
	debug('Backend assigned metadata', data);
	const socket = sockets[data.a.s];
	if(!socket.meta) {
		socket.meta = {};
	}
	Object.assign(socket.meta, data.md); 
};

const handlers = {
	c
};

const worker = async (workerId) => {
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

		const realm = 'dlq';

		socket.on('close', event => {
			debug('close', event);
			delete sockets[uuid];
			options.pubSub.publish(realm, rmEmptyValues({ a: { s: uuid }, md: socket.meta, c: 'c' }));
		});

		socket.on('error', event => {
			debug('error', event);
		});

		// Maybe add crypto key to socket addr to prevent spoofing?
		socket.on('message', async message => {
			options.pubSub.publish(realm, rmEmptyValues({ a: { s: uuid }, md: socket.meta, m: message }));
		});

		options.pubSub.subscribe(data => {
			const socket = sockets[data.a.s];
			if(data.m) {
				socket.send(data.m);
			}
			if(data.c) {
				const handler = handlers[data.c];
				if(handler) {
					handler(data);
				} else {
					debug('Unknown backend command:', data.c);
				}
			}
		});

		options.pubSub.publish(realm, rmEmptyValues({ a: { s: uuid }, md: socket.meta, c: 'o' }));
	});
}

const numClusterWorkers = parseInt(process.env.OS_CPUS || 1);
if (cluster.isPrimary) {
	for (let i = 0; i < numClusterWorkers; i++) {
		const worker = cluster.fork();

		worker.on('error', error => {
			debug(`worker errror ${worker.process.pid}`, error);
		});

		worker.on('exit', (code, signal) => {
			debug(`worker exit ${worker.process.pid} ${code} ${signal}`);
		});
	}

	cluster.on('exit', (worker, code, signal) => {
		debug(`cluster worker exit ${worker.process.pid} ${code} ${signal}`);
	});
} else {
	debug('Starting worker', cluster.worker.id, 'of', numClusterWorkers);
	worker(cluster.worker.id);
}

