import Debug from 'debug';
const debug = Debug('ws-pubsub:realms:registry');

import { MongoClient } from 'mongodb';
import { openSecret, secretAad } from './secrets.js';

/** The registry can't be reached and has nothing cached for the realm */
export class RegistryUnavailable extends Error {
	constructor(cause, registered) {
		super(`Realm registry unavailable: ${cause?.message || cause}`);
		// true: the realm was registered when the id list was last loaded;
		// null: no id list was ever loaded, so nobody knows
		this.registered = registered;
	}
}

/**
 * Realms registered in ws-pubsub-admin (collection `realms`), cached.
 * get(id) resolves to:
 *   null                    not registered
 *   { realm, secrets }      registered, secrets opened
 *   { realm, error }        registered but unusable (e.g. secrets can't be opened)
 * or throws RegistryUnavailable.
 *
 * Every cacheMs a background refresh reloads the ids of all registered
 * realms and the settings of the cached ones; lookups are served from the
 * cache. So a realm never seen before is known to be unregistered even
 * while the database is down, and an outage costs no time: after a failure
 * lookups skip the database until a refresh succeeds. (Only the first
 * refresh, at start, is waited for: up to connectTimeoutMs if the database
 * is down then.)
 *
 * options: uri, keys, cacheMs, connectTimeoutMs, maxCached; collection (tests: a
 * function resolving to a collection-like { findOne, find })
 */
export function createRegistry({ uri, keys, cacheMs = 30000, connectTimeoutMs = 5000, maxCached = 10000, collection: getCollection }) {
	let clientPromise = null;
	const cache = new Map(); // id -> { at, value }
	const refreshing = new Map(); // id -> promise
	let known = null; // Set of registered ids, from the last successful load
	let down = false; // the last database call failed

	const collection = getCollection || (async () => {
		if(!clientPromise) {
			clientPromise = new MongoClient(uri, { serverSelectionTimeoutMS: connectTimeoutMs }).connect()
				.catch(err => { clientPromise = null; throw err; });
		}
		return (await clientPromise).db().collection('realms');
	});

	const resolve = doc => {
		if(!doc) {
			return null;
		}
		const secrets = {};
		try {
			for(const [name, sealed] of Object.entries(doc.backend?.secrets || {})) {
				secrets[name] = openSecret(keys, sealed, secretAad(doc.id, name));
			}
		} catch(err) {
			debug('Cannot open secrets of realm', doc.id, err.message);
			return { realm: doc, error: 'Realm secrets cannot be opened by this gateway' };
		}
		return { realm: doc, secrets };
	};

	const failed = err => {
		if(!down) debug('Registry unavailable:', err.message || err);
		down = true;
	};

	const fetch = id => {
		let p = refreshing.get(id);
		if(!p) {
			p = (async () => {
				try {
					const doc = await (await collection()).findOne({ id }, { projection: { _id: 0 } });
					down = false;
					const value = resolve(doc);
					// Clients pick realm ids: keep the cache bounded (oldest out)
					if(cache.size >= maxCached) cache.delete(cache.keys().next().value);
					cache.set(id, { at: Date.now(), value });
					return value;
				} catch(err) {
					failed(err);
					throw err;
				}
			})().finally(() => refreshing.delete(id));
			refreshing.set(id, p);
		}
		return p;
	};

	const refresh = async () => {
		try {
			const realms = await collection();
			const docs = await realms.find({}, { projection: { _id: 0, id: 1 } }).toArray();
			known = new Set(docs.map(d => d.id));
			down = false;
			// Cached realms: changed, deleted or newly registered ones
			const ids = [...cache.keys()];
			const current = ids.length
				? await realms.find({ id: { $in: ids } }, { projection: { _id: 0 } }).toArray()
				: [];
			const byId = new Map(current.map(d => [d.id, d]));
			const now = Date.now();
			for(const id of ids) {
				const doc = byId.get(id) || null;
				const before = cache.get(id)?.value?.realm;
				const unchanged = before && doc && before.revision === doc.revision;
				cache.set(id, unchanged ? { ...cache.get(id), at: now } : { at: now, value: resolve(doc) });
			}
		} catch(err) {
			failed(err);
		}
	};
	const loaded = refresh();
	const timer = setInterval(refresh, cacheMs);
	timer.unref?.();

	return {
		/** Resolves once the first id list load was tried (tests) */
		ready: () => loaded,

		async get(id) {
			await loaded;
			const hit = cache.get(id);
			if(hit) {
				return hit.value; // the background refresh keeps it current
			}
			if(!down) {
				try {
					return await fetch(id);
				} catch {
					// falls through to what the id list says
				}
			}
			if(known && !known.has(id)) {
				return null;
			}
			throw new RegistryUnavailable('database not reachable', known ? true : null);
		},

		async close() {
			clearInterval(timer);
			if(clientPromise) {
				try { await (await clientPromise).close(); } catch {}
			}
		},
	};
}
