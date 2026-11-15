// End to end: a gateway process, a fake ws-pubsub-admin (its /agent/v1
// protocol), the platform Redis and a realm's own Redis.
//   WS_TEST_REDIS=redis://127.0.0.1:6379            platform Redis
//   WS_TEST_REALM_REDIS=redis://:pw@127.0.0.1:6380  a realm's Redis (with a password)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createClient } from 'redis';
import WebSocket, { WebSocketServer } from 'ws';

const { WS_TEST_REDIS, WS_TEST_REALM_REDIS } = process.env;
const APP = fileURLToPath(new URL('..', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const param = (name, value) => Buffer.from(`${name}: ${value}`).toString('base64').replace(/=+$/, '');
const TOKEN = 'test-token';

/** Plays ws-pubsub-admin's /agent/v1 */
function fakeAdmin() {
	const wss = new WebSocketServer({ port: 0, path: '/agent/v1', verifyClient: ({ req }) => req.headers.authorization === `Bearer ${TOKEN}` });
	const admin = {
		realms: new Map(),
		checks: [],
		// (msg) -> verdict, or null to never answer
		verdict: () => ({ allow: true }),
		url: () => `ws://127.0.0.1:${wss.address().port}/agent/v1`,
		send: msg => wss.clients.forEach(c => c.send(JSON.stringify(msg))),
		upsert(realm) {
			admin.realms.set(realm.id, realm);
			admin.send({ type: 'upsert', realm });
		},
		close: () => new Promise(r => { wss.clients.forEach(c => c.terminate()); wss.close(r); }),
	};
	wss.on('connection', ws => {
		ws.send(JSON.stringify({ type: 'snapshot', realms: [...admin.realms.values()] }));
		ws.on('message', raw => {
			const msg = JSON.parse(raw);
			if(msg.type !== 'check') return;
			admin.checks.push(msg);
			const verdict = admin.verdict(msg);
			if(verdict) ws.send(JSON.stringify({ type: 'check_result', req_id: msg.req_id, ...verdict }));
		});
	});
	return admin;
}

describe('realm routing', { skip: !(WS_TEST_REDIS && WS_TEST_REALM_REDIS) && 'set WS_TEST_REDIS, WS_TEST_REALM_REDIS' }, () => {
	let gateway, admin, platformRedis, realmRedis, port;
	const realmUrl = new URL(WS_TEST_REALM_REDIS);
	const realmPassword = decodeURIComponent(realmUrl.password);

	const realm = (id, overrides = {}) => ({
		id, status: 'enabled', revision: 1,
		allowed_origins: ['https://app.test'],
		ttl_ms: 120000,
		limits: { max_message_bytes: 100, allow_binary: false },
		backend: { type: 'redis_streams', config: { host: realmUrl.hostname, port: Number(realmUrl.port) } },
		secrets: { password: realmPassword },
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
				WSPA_URL: admin.url(), WSPA_TOKEN: TOKEN,
				DEBUG: '',
				...env,
			},
			stdio: 'ignore',
		});
		// Up once it accepts sockets (the probe realm may then be refused)
		for(let i = 0; i < 50; i++) {
			try {
				await new Promise((resolve, reject) => {
					const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, [param('ws-realm', 'probe')]);
					ws.on('open', () => { ws.close(); resolve(); });
					ws.on('error', reject);
				});
				break;
			} catch {
				await sleep(100);
			}
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
	const backend = (redis, stream, extra = {}) => {
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
							await redis.xAdd(env.addr.topic, '*', { message: JSON.stringify({ addr: env.addr, message: `echo:${text}`, ...extra }) });
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
	// Connects, sends "ping" and waits for the backend's echo
	const echoes = async (realmId, stream, redis, headers = {}) => {
		const svc = backend(redis, stream);
		try {
			const { ws, messages } = await connect(realmId, headers);
			ws.send('ping');
			const ok = await waitFor(() => messages.includes('echo:ping'));
			ws.close();
			return ok;
		} finally {
			svc.stop();
		}
	};

	before(async () => {
		platformRedis = await createClient({ url: WS_TEST_REDIS }).connect();
		realmRedis = await createClient({ url: WS_TEST_REALM_REDIS }).connect();
		admin = fakeAdmin();
		await sleep(50);
		for(const r of [
			realm('chat'),
			realm('off', { status: 'disabled' }),
			realm('kafkaish', { backend: { type: 'kafka', config: { brokers: ['k:9092'] } }, secrets: {} }),
			realm('badkey', { secrets: {}, secrets_error: 'Realm secrets cannot be opened' }),
		]) admin.realms.set(r.id, r);
		await startGateway();
	});
	after(async () => {
		await stopGateway();
		await admin?.close();
		await platformRedis?.disconnect();
		await realmRedis?.disconnect();
	});

	it('routes a registered realm to its own Redis, with its topics and TTL, after admin confirms the connection', async () => {
		const svc = backend(realmRedis, 'app.acme.chat.req');
		const { ws, messages } = await connect('chat', { 'ws-tenant': 'acme' });
		ws.send('hello');
		assert.ok(await waitFor(() => messages.includes('echo:hello')), `no echo: ${messages}`);
		const msg = svc.seen.find(e => e.message);
		assert.match(msg.addr.topic, /^app\.chat\.res\.[0-9a-f-]{36}$/, 'reply topic from template');
		assert.ok(msg.exp > Date.now() + 100000 && msg.exp <= Date.now() + 120000, 'realm TTL');
		assert.ok(svc.seen.find(e => e.wsctl === 'open')?.conn, 'open event with conn');
		assert.equal(await platformRedis.exists('ws-test.req.chat'), 0, 'nothing on the platform Redis');
		const check = admin.checks.find(c => c.realm === 'chat');
		assert.equal(check.origin, 'https://app.test');
		assert.equal(check.headers['ws-tenant'], 'acme');
		assert.ok(check.ip, 'client ip sent');
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

	it('refuses: other origin, disabled, missing or unsafe header, unsupported backend, unopenable secrets, admin says no', async () => {
		admin.verdict = msg => (msg.headers['ws-tenant'] === 'banned' ? { allow: false, code: 1008, reason: 'Banned by admin' } : { allow: true });
		const cases = [
			[['chat', { 'ws-tenant': 'acme' }, 'https://evil.test'], /Origin not allowed/],
			[['off', { 'ws-tenant': 'acme' }], /disabled/],
			[['chat', {}], /Missing header ws-tenant/],
			[['chat', { 'ws-tenant': '../other' }], /must be/],
			[['kafkaish', { 'ws-tenant': 'acme' }], /not supported/],
			[['badkey', { 'ws-tenant': 'acme' }], /cannot be opened/],
			[['chat', { 'ws-tenant': 'banned' }], /Banned by admin/],
		];
		for(const [args, reason] of cases) {
			const { ws } = await connect(...args);
			const info = await closedWith(ws);
			assert.ok(info, `${args[0]}: not closed`);
			assert.match(info.reason, reason, JSON.stringify(info));
		}
		admin.verdict = () => ({ allow: true });
	});

	it('keeps unregistered realms on the platform Redis, without asking admin', async () => {
		const asked = admin.checks.length;
		assert.ok(await echoes('dating', 'ws-test.req.dating', platformRedis));
		assert.equal(admin.checks.length, asked);
	});

	it('binary frames: compact base64 for connections whose backend says it reads it, the old form otherwise', async () => {
		const binaryOf = async (svc, ws, messages) => {
			const before = svc.seen.length;
			ws.send(Buffer.from([0, 1, 2, 255]), { binary: true });
			await waitFor(() => svc.seen.slice(before).some(e => e.isBinary));
			return svc.seen.slice(before).find(e => e.isBinary);
		};
		let svc = backend(platformRedis, 'ws-test.req.photos');
		let { ws, messages } = await connect('photos');
		ws.send('hi');
		await waitFor(() => messages.includes('echo:hi'));
		let frame = await binaryOf(svc, ws, messages);
		assert.equal(frame.encoding, 'buffer', 'old backends keep working');
		assert.deepEqual(Buffer.from(frame.message), Buffer.from([0, 1, 2, 255]));
		ws.close();
		svc.stop();

		svc = backend(platformRedis, 'ws-test.req.photos', { accepts: ['base64'] });
		({ ws, messages } = await connect('photos'));
		ws.send('hi');
		await waitFor(() => messages.includes('echo:hi'));
		frame = await binaryOf(svc, ws, messages);
		assert.equal(frame.encoding, 'base64');
		assert.deepEqual(Buffer.from(frame.message, 'base64'), Buffer.from([0, 1, 2, 255]));
		const text = svc.seen.find(e => e.message === 'hi');
		assert.equal(text?.encoding, 'utf8', 'text frames are plain strings');
		ws.close();
		svc.stop();
	});

	it('applies changes pushed by admin at once, and reads without busy-looping', async () => {
		admin.upsert({ ...realm('chat'), status: 'disabled', revision: 2 });
		await sleep(100);
		const { ws } = await connect('chat', { 'ws-tenant': 'acme' });
		assert.match((await closedWith(ws)).reason, /disabled/);
		admin.upsert({ ...realm('chat'), revision: 3 });

		const count = async () => Number((await platformRedis.info('stats')).match(/total_commands_processed:(\d+)/)[1]);
		const before = await count();
		await sleep(3000);
		const idle = (await count()) - before;
		assert.ok(idle < 30, `${idle} Redis commands in 3 s of idle`);
	});

	it('admin slow: allowed on the pushed settings, or refused with WS_ADMIN_CHECK_REQUIRED', async () => {
		admin.verdict = () => null; // never answers
		const started = Date.now();
		assert.ok(await echoes('chat', 'app.acme.chat.req', realmRedis, { 'ws-tenant': 'acme' }), 'allowed after the check timed out');
		assert.ok(Date.now() - started < 4500, 'check timeout honoured');

		await stopGateway();
		await startGateway({ WS_ADMIN_CHECK_REQUIRED: 'true', WS_ADMIN_CHECK_TIMEOUT: '300ms' });
		const { ws } = await connect('chat', { 'ws-tenant': 'acme' });
		assert.match((await closedWith(ws)).reason, /registry unavailable/);
		admin.verdict = () => ({ allow: true });
	});

	it('admin down since start: unknown realms use the platform (hosted); agents refuse them', async () => {
		await stopGateway();
		await startGateway({ WSPA_URL: 'ws://127.0.0.1:1/agent/v1' });
		assert.ok(await echoes('dating', 'ws-test.req.dating', platformRedis), 'platform realm broke without admin');

		await stopGateway();
		await startGateway({ WS_MODE: 'agent', WSPA_URL: 'ws://127.0.0.1:1/agent/v1' });
		const { ws } = await connect('dating');
		assert.match((await closedWith(ws, 8000)).reason, /Unknown realm|unavailable/);
	});

	it('agent mode: registered realms only, broker credentials from a local file', async () => {
		const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsp-')), 'local.json');
		fs.writeFileSync(file, JSON.stringify({ 'local-pw': { secrets: { password: realmPassword } } }));
		admin.realms.set('local-pw', realm('local-pw', { secrets: {} })); // admin doesn't have the password
		await stopGateway();
		await startGateway({ WS_MODE: 'agent', WS_LOCAL_REALMS_FILE: file });

		assert.ok(await echoes('local-pw', 'app.acme.local-pw.req', realmRedis, { 'ws-tenant': 'acme' }), 'local password used');
		const { ws } = await connect('dating');
		assert.match((await closedWith(ws)).reason, /Unknown realm/, 'no platform Redis in agent mode');
	});
});
