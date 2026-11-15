// The admin registry against an in-process fake admin
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { createAdminRegistry, RegistryUnavailable } from '../realms/admin-registry.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const realm = (id, extra = {}) => ({ id, status: 'enabled', revision: 1, backend: { type: 'redis_streams', config: { host: 'far.example', port: 6379 } }, secrets: { password: 'admin-pw' }, ...extra });

const fakeAdmin = (realms, onCheck = () => null) => {
	const wss = new WebSocketServer({ port: 0 });
	wss.on('connection', ws => {
		ws.send(JSON.stringify({ type: 'snapshot', realms }));
		ws.on('message', raw => {
			const msg = JSON.parse(raw);
			const verdict = msg.type === 'check' && onCheck(msg);
			if(verdict) ws.send(JSON.stringify({ type: 'check_result', req_id: msg.req_id, ...verdict }));
		});
	});
	return new Promise(r => wss.on('listening', () => r({ wss, url: `ws://127.0.0.1:${wss.address().port}` })));
};

describe('admin registry', () => {
	it('serves the snapshot, merges local settings, keeps serving when admin goes away', async () => {
		const { wss, url } = await fakeAdmin([realm('chat'), realm('sealed', { secrets: {}, secrets_error: 'x' })], msg => ({ allow: msg.origin === 'https://ok' }));
		const registry = createAdminRegistry({
			url, token: 't', checkTimeoutMs: 200, maxRetryDelay: 100,
			local: { chat: { config: { host: '10.0.0.5' }, secrets: { password: 'local-pw' } } },
		});
		await registry.ready();
		const { realm: r, secrets } = await registry.get('chat');
		assert.equal(r.backend.config.host, '10.0.0.5', 'local config wins');
		assert.equal(r.backend.config.port, 6379, 'admin config kept');
		assert.deepEqual(secrets, { password: 'local-pw' });
		assert.match((await registry.get('sealed')).error, /cannot be opened/);
		assert.equal(await registry.get('nope'), null);
		assert.equal((await registry.check('chat', { origin: 'https://ok' })).allow, true);
		assert.equal((await registry.check('chat', { origin: 'https://bad' })).allow, false);

		for(const c of wss.clients) c.terminate();
		wss.close();
		await sleep(50);
		assert.equal(registry.connected(), false);
		assert.ok((await registry.get('chat')).realm, 'last snapshot still served');
		assert.deepEqual(await registry.check('chat', {}), { allow: true, unchecked: true });
		await registry.close();
	});

	it('never reached: says nobody knows, without waiting', async () => {
		const registry = createAdminRegistry({ url: 'ws://127.0.0.1:1', token: 't', readyTimeoutMs: 10000 });
		const started = Date.now();
		await assert.rejects(registry.get('x'), err => err instanceof RegistryUnavailable && err.registered === null);
		assert.ok(Date.now() - started < 2000);
		await registry.close();
	});

	it('requireCheck: refuses when admin does not answer', async () => {
		const { wss, url } = await fakeAdmin([realm('chat')]);
		const registry = createAdminRegistry({ url, token: 't', checkTimeoutMs: 100, requireCheck: true });
		await registry.ready();
		assert.equal((await registry.check('chat', {})).allow, false);
		await registry.close();
		wss.close();
	});
	it('token refused or revoked: drops its realms and keeps retrying', async () => {
		const refused = new WebSocketServer({ port: 0, verifyClient: () => false });
		await new Promise(r => refused.on('listening', r));
		const r1 = createAdminRegistry({ url: `ws://127.0.0.1:${refused.address().port}`, token: 'bad', maxRetryDelay: 100 });
		await assert.rejects(r1.get('chat'), RegistryUnavailable);
		await r1.close();
		refused.close();

		const { wss, url } = await fakeAdmin([realm('chat')]);
		const r2 = createAdminRegistry({ url, token: 't', maxRetryDelay: 100 });
		await r2.ready();
		assert.ok(await r2.get('chat'));
		wss.on('connection', ws => ws.close(4401, 'Token revoked')); // and on every reconnect
		for(const c of wss.clients) c.close(4401, 'Token revoked');
		await sleep(100);
		await assert.rejects(r2.get('chat'), RegistryUnavailable, 'revoked: no longer serves the realm');
		await r2.close();
		wss.close();
	});
});
