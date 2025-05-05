import Debug from 'debug';
const debug = Debug('ws-pubsub:cluster');

import cluster from 'node:cluster';

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
	(async () => {
		(await import('./worker.js')).default(cluster.worker.id);
	})();
}

