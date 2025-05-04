import Debug from 'debug';
const debug = Debug('ws-pubsub:main');

import cluster from 'node:cluster';
import { WebSocketServer }	from 'ws';

import options from './options.js';

const sockets = {};

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

		socket.on('close', event => {
			debug('close', event);
			delete sockets[uuid];
		});

		socket.on('error', event => {
			debug('error', event);
		});

		// Maybe add crypto key to socket addr to prevent spoofing?
		socket.on('message', async message => {
			options.pubSub.publish({ a: { s: uuid }, m: message });
		});

		options.pubSub.subscribe(data => {
			const socket = sockets[data.a.s];
			socket.send(data.m);
		});
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

