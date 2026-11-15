// End to end: a gateway process with the admin's registry, the platform
// Redis and a realm's own Redis.
//   WS_TEST_REDIS=redis://127.0.0.1:6379            platform Redis
//   WS_TEST_REALM_REDIS=redis://:pw@127.0.0.1:6380  a realm's Redis (with a password)
//   WS_TEST_MONGODB=mongodb://127.0.0.1:27017       registry
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import WebSocket from 'ws';

const { WS_TEST_REDIS, WS_TEST_REALM_REDIS, WS_TEST_MONGODB } = process.env;
const APP = fileURLToPath(new URL('..', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEY = crypto.randomBytes(32);

// Sealed like ws-pubsub-admin does
const seal = (value, realm, field) => {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
	cipher.setAAD(Buffer.from(`wspa:${realm}:backend.secrets.${field}`));
	const ct = Buffer.concat([cipher.update(value), cipher.final()]);
	return `wspa:enc:v1:k1:${Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url')}`;
};
const param = (name, value) => Buffer.from(`${name}: ${value}`).toString('base64').replace(/=+$/, '');

describe('realm routing', { skip: !(WS_TEST_REDIS && WS_TEST_REALM_REDIS && WS_TEST_MONGODB) && 'set WS_TEST_REDIS, WS_TEST_REALM_REDIS, WS_TEST_MONGODB' }, () => {
	let gateway, mongo, db, platformRedis, realmRedis, port, dbName;
	const realmUrl = new URL(WS_TEST_REALM_REDIS);

	const realm = (id, overrides = {}) => ({
		id, owner_id: 'u', status: 'enabled', revision: 1,
		allowed_origins: ['https://app.test'],
		ttl_ms: 120000,
		limits: { max_message_bytes: 100, allow_binary: false },
		backend: {
			type: 'redis_streams',
			config: { host: realmUrl.hostname, port: Number(realmUrl.port) },
			secrets: { password: seal(decodeURIComponent(realmUrl.password), id, 'password') },
		},
		topics: { request: 'app.{header.ws-tenant}.{realm}.req', reply: 'app.{realm}.res.{gateway}' },
		...overrides,
	});

	const startGateway = async (env = {}) => {
		port = 39000 + Math.floor(Math.random() * 900);
		const platform = new URL(WS_TEST_REDIS);
		gateway = spawn(process.execPath, ['cluster.js'], {
			cwd: APP,
			env: {
				...process.env, ENV: 'test', PORT: String(port), OS_CPUS: '1',
				REDIS_HOST: platform.hostname, REDIS_PORT: platform.port,
				WSPA_MONGODB: `${WS_TEST_MONGODB}/${dbName}`, SECRETS_KEYS: `k1:${KEY.toString('base64')}`,
				WS_REALM_CACHE: '200ms', DEBUG: '',
				...env,
			},
			stdio: 'ignore',
		});
		for(let i = 0; i < 50; i++) {
			try { await connect('probe-not-a-realm-wait', {}, 'x'); break; } catch { await sleep(100); }
		}
	};
	const stopGateway = async () => {
		gateway?.kill();
		await sleep(300);
	};

	// Opens a socket; resolves { ws, messages } once open, rejects { code, reason } if closed first
	const connect = (realmId, headers = {}, origin = 'https://app.test') => new Promise((resolve, reject) => {
		const protocols = [param('ws-realm', realmId), ...Object.entries(headers).map(([k, v]) => param(k, v))];
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, protocols, { headers: { origin } });
		const messages = [];
		ws.on('message', data => messages.push(String(data)));
		let opened = false;
		ws.on('open', () => { opened = true; resolve({ ws, messages }); });
		ws.on('close', (code, reason) => { if(!opened) reject({ code, reason: String(reason) }); else ws.closeInfo = { code, reason: String(reason) }; });
		ws.on('error', err => { if(!opened) reject({ code: 0, reason: err.message }); });
	});
	const closedWith = async (ws, ms = 3000) => {
		for(let t = 0; t < ms && !ws.closeInfo; t += 50) await sleep(50);
		return ws.closeInfo;
	};

	// A backend: reads `stream` on `redis`, answers each message to addr.topic
	const backend = (redis, stream) => {
		const seen = [];
		let stop = false;
		(async () => {
			const reader = redis.duplicate();
			await reader.connect();
			await reader.xGroupCreate(stream, 'svc', '0', { MKSTREAM: true }).catch(() => {});
			while(!stop) {
				const res = await reader.xReadGroup('svc', 'w', { key: stream, id: '>' }, { COUNT: 10, BLOCK: 500 });
				for(const { messages } of res || []) {
					for(const { id, message } of messages) {
						const env = JSON.parse(message.message);
						seen.push(env);
						if(env.message) {
							const text = Buffer.from(env.message).toString();
							await redis.xAdd(env.addr.topic, '*', { message: JSON.stringify({ addr: env.addr, message: `echo:${text}` }) });
						}
						await reader.xAck(stream, 'svc', id);
					}
				}
			}
			await reader.disconnect();
		})();
		return { seen, stop: () => { stop = true; } };
	};
	const waitFor = async (fn, ms = 4000) => {
		for(let t = 0; t < ms; t += 50) {
			const v = fn();
			if(v) return v;
			await sleep(50);
		}
		return fn();
	};

	before(async () => {
		dbName = `wsp_test_${Date.now()}`;
		mongo = await new MongoClient(WS_TEST_MONGODB).connect();
		db = mongo.db(dbName);
		platformRedis = await createClient({ url: WS_TEST_REDIS }).connect();
		realmRedis = await createClient({ url: WS_TEST_REALM_REDIS }).connect();
		await db.collection('realms').insertMany([
			realm('chat'),
			realm('off', { status: 'disabled' }),
			realm('kafkaish', { backend: { type: 'kafka', config: { brokers: ['k:9092'] }, secrets: {} } }),
			realm('badkey', { backend: { type: 'redis_streams', config: { host: 'x', port: 1 }, secrets: { password: 'wspa:enc:v1:k1:AAAA' } } }),
		]);
		await startGateway();
	});
	after(async () => {
		await stopGateway();
		await db?.dropDatabase();
		await mongo?.close();
		await platformRedis?.disconnect();
		await realmRedis?.disconnect();
	});

	it('routes a registered realm to its own Redis, with its topics and TTL', async () => {
		const svc = backend(realmRedis, 'app.acme.chat.req');
		const { ws, messages } = await connect('chat', { 'ws-tenant': 'acme' });
		ws.send('hello');
		assert.ok(await waitFor(() => messages.includes('echo:hello')), `no echo: ${messages}`);
		const msg = svc.seen.find(e => e.message);
		assert.match(msg.addr.topic, /^app\.chat\.res\.[0-9a-f-]{36}$/, 'reply topic from template');
		assert.ok(msg.exp > Date.now() + 100000 && msg.exp <= Date.now() + 120000, 'realm TTL');
		assert.ok(svc.seen.find(e => e.wsctl === 'open')?.conn, 'open event with conn');
		assert.equal(await platformRedis.exists('ws-test.req.chat'), 0, 'nothing on the platform Redis');
		ws.close();
		svc.stop();
	});

	it('enforces message size and binary limits', async () => {
		const { ws, messages } = await connect('chat', { 'ws-tenant': 'acme' });
		ws.send('x'.repeat(101));
		ws.send(Buffer.from([1, 2, 3]), { binary: true });
		assert.ok(await waitFor(() => messages.length >= 2));
		assert.match(messages[0], /too large/);
		assert.match(messages[1], /Binary/);
		ws.close();
	});

	it('refuses: other origin, disabled, missing or unsafe header, unsupported backend, unopenable secrets', async () => {
		const cases = [
			[['chat', { 'ws-tenant': 'acme' }, 'https://evil.test'], /Origin not allowed/],
			[['off', { 'ws-tenant': 'acme' }], /disabled/],
			[['chat', {}], /Missing header ws-tenant/],
			[['chat', { 'ws-tenant': '../other' }], /must be/],
			[['kafkaish', { 'ws-tenant': 'acme' }], /not supported/],
			[['badkey', { 'ws-tenant': 'acme' }], /cannot be opened/],
		];
		for(const [args, reason] of cases) {
			const { ws } = await connect(...args);
			const info = await closedWith(ws);
			assert.ok(info, `${args[0]}: not closed`);
			assert.match(info.reason, reason, JSON.stringify(info));
		}
	});

	it('keeps unregistered realms on the platform Redis', async () => {
		const svc = backend(platformRedis, 'ws-test.req.dating');
		const { ws, messages } = await connect('dating');
		ws.send('hi');
		assert.ok(await waitFor(() => messages.includes('echo:hi')), `no echo: ${messages}`);
		ws.close();
		svc.stop();
	});

	it('picks up realm changes (cache) and reads without busy-looping', async () => {
		await db.collection('realms').updateOne({ id: 'chat' }, { $set: { status: 'disabled' }, $inc: { revision: 1 } });
		await sleep(400);
		const { ws } = await connect('chat', { 'ws-tenant': 'acme' });
		assert.match((await closedWith(ws)).reason, /disabled/);

		const count = async () => Number((await platformRedis.info('stats')).match(/total_commands_processed:(\d+)/)[1]);
		const before = await count();
		await sleep(3000);
		const idle = (await count()) - before;
		assert.ok(idle < 30, `${idle} Redis commands in 3 s of idle`);
	});

	it('registry down since start: unknown realms use the platform; strict refuses them', async () => {
		await stopGateway();
		await startGateway({ WSPA_MONGODB: 'mongodb://127.0.0.1:1/none' });
		const svc = backend(platformRedis, 'ws-test.req.dating');
		// The first lookups wait for the registry's first (failing) load
		const first = await connect('dating');
		first.ws.send('still here');
		assert.ok(await waitFor(() => first.messages.includes('echo:still here'), 10000), 'platform realm broke without the registry');
		first.ws.close();
		svc.stop();
		// After that, nothing waits on the dead registry
		const svc2 = backend(platformRedis, 'ws-test.req.new-pages');
		const started = Date.now();
		const { ws, messages } = await connect('new-pages');
		ws.send('quick');
		assert.ok(await waitFor(() => messages.includes('echo:quick')), 'unknown realm on the platform');
		assert.ok(Date.now() - started < 3000, `${Date.now() - started} ms: waited on the dead registry`);
		ws.close();
		svc2.stop();

		await stopGateway();
		await startGateway({ WS_REALMS_STRICT: 'true', WSPA_MONGODB: 'mongodb://127.0.0.1:1/none' });
		const { ws: unknown } = await connect('nobody');
		assert.match((await closedWith(unknown, 8000)).reason, /registry unavailable/);

		await stopGateway();
		await startGateway({ WS_REALMS_STRICT: 'true' });
		const { ws: stranger } = await connect('nobody');
		assert.match((await closedWith(stranger)).reason, /Unknown realm/);
	});
});
