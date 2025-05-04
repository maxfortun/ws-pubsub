import Debug from 'debug';
const debug = Debug('ws-pubsub:main');

import cluster from 'node:cluster';
import { WebSocketServer }	from 'ws';

import { rmEmptyValues } from './utils.js';

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
	const webSocketServer = new WebSocketServer({ 
		host: '0.0.0.0',
		port: process.env.PORT || 3000,
		path: options.ws_path
	}, () => {
		debug('Started');
	});

	webSocketServer.on('connection', (socket, req) => {
		debug(`New connection`);
		const uuid = crypto.randomUUID();

		// may also need to set TcpAckFrequency to 1 
		socket.setNoDelay(true);
		sockets[uuid] = socket;

		// Protocol needs to have a dest specified. We'd need to validate it
		const protocol = socket.protocol;
		debug(`Protocol: ${protocol}`);
		const dest = 'default';

		socket.on('close', event => {
			debug('close', event);
			delete sockets[uuid];
			options.pubSub.publish(dest, rmEmptyValues({ a: { s: uuid }, md: socket.meta, c: 'c' }));
		});

		socket.on('error', event => {
			debug('error', event);
		});

		// Maybe add crypto key to socket addr to prevent spoofing?
		socket.on('message', async message => {
			options.pubSub.publish(dest, rmEmptyValues({ a: { s: uuid }, md: socket.meta, m: message }));
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

		options.pubSub.publish(dest, rmEmptyValues({ a: { s: uuid }, md: socket.meta, c: 'o' }));
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

