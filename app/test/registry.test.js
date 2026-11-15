// The registry and router through a database outage, with a fake collection
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRegistry, RegistryUnavailable } from '../realms/registry.js';
import { createRouter } from '../realms/router.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A collection-like fake: `up` toggles an outage; calls are counted
function fakeDb(docs) {
	const db = { up: true, calls: 0, docs };
	const check = () => {
		db.calls++;
		if(!db.up) throw new Error('connection refused');
	};
	db.collection = async () => ({
		findOne: async ({ id }) => { check(); return db.docs.find(d => d.id === id) || null; },
		find: filter => ({ toArray: async () => {
			check();
			const ids = filter?.id?.$in;
			return ids ? db.docs.filter(d => ids.includes(d.id)) : db.docs.map(d => ({ id: d.id }));
		} }),
	});
	return db;
}

const realm = id => ({ id, status: 'enabled', revision: 1, backend: { type: 'redis_streams', config: {}, secrets: {} } });

describe('registry outage', () => {
	it('serves cached realms, knows unregistered ones from the id list, refuses registered ones it has no settings for', async () => {
		const db = fakeDb([realm('cached'), realm('uncached')]);
		const registry = createRegistry({ collection: db.collection, keys: new Map(), cacheMs: 50 });
		await registry.ready();
		assert.equal((await registry.get('cached')).realm.id, 'cached');
		assert.equal(await registry.get('dating'), null);

		db.up = false;
		await sleep(80); // the id list refresh notices the outage
		assert.equal((await registry.get('cached')).realm.id, 'cached', 'stale beats refusing');
		assert.equal(await registry.get('never-seen'), null, 'not on the id list');
		await assert.rejects(registry.get('uncached'), err => err instanceof RegistryUnavailable && err.registered === true);

		// no database calls per lookup while it's down
		const calls = db.calls;
		for(let i = 0; i < 20; i++) await registry.get('never-seen');
		assert.ok(db.calls - calls <= 1, `${db.calls - calls} calls`);

		db.up = true;
		db.docs.push(realm('new-one'));
		db.docs[0] = { ...realm('cached'), status: 'disabled', revision: 2 };
		await sleep(80);
		assert.equal((await registry.get('new-one')).realm.id, 'new-one', 'back after the outage');
		assert.equal((await registry.get('cached')).realm.status, 'disabled', 'cached realms refreshed in the background');
		db.docs.splice(0, 1);
		await sleep(80);
		assert.equal(await registry.get('cached'), null, 'deleted');
		await registry.close();
	});

	it('down since start: nobody knows, so the error says so', async () => {
		const db = fakeDb([]);
		db.up = false;
		const registry = createRegistry({ collection: db.collection, keys: new Map(), cacheMs: 1000 });
		await registry.ready();
		await assert.rejects(registry.get('x'), err => err instanceof RegistryUnavailable && err.registered === null);
		await registry.close();
	});

	it('routes: unknown to the platform unless strict; a registered realm never to the platform', async () => {
		const db = fakeDb([realm('theirs')]);
		const registry = createRegistry({ collection: db.collection, keys: new Map(), cacheMs: 50 });
		await registry.ready();
		db.up = false;
		await sleep(80);
		const published = [];
		const platform = { publish: (r, data) => published.push(r) };
		const router = strict => createRouter({ registry, platform, strict, allowedOrigins: [], env: 'test', gatewayId: 'g' });

		const route = await router(false).route('dating', { origin: 'https://x', headers: {} });
		route.publish({ addr: {} });
		assert.deepEqual(published, ['dating']);
		await assert.rejects(router(false).route('theirs', { origin: 'https://x', headers: {} }), /registry unavailable/);
		await assert.rejects(router(true).route('nobody', { origin: 'https://x', headers: {} }), /Unknown realm/);
		await registry.close();
	});
});
