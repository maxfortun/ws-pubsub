import Debug from 'debug';
const debug = Debug('ws-pubsub:realms:admin');

import fs from 'node:fs';
import os from 'node:os';
import WebSocket from 'ws';

/** Admin can't be reached and the realm isn't known */
export class RegistryUnavailable extends Error {
	constructor(message, registered = null) {
		super(`Realm registry unavailable: ${message}`);
		// true: the realm is registered (last we heard); null: nobody knows
		this.registered = registered;
	}
}

/**
 * "Local" realm settings, merged over what admin sends - for broker
 * credentials (or hosts) that should stay next to the broker:
 *   { "<realm>": { "config": { "host": "10.0.0.5" }, "secrets": { "password": "..." } } }
 */
export function loadLocalRealms(file) {
	if(!file) {
		return {};
	}
	const local = JSON.parse(fs.readFileSync(file, 'utf8'));
	if(!local || typeof local !== 'object' || Array.isArray(local)) {
		throw new Error(`${file}: expected { "<realm>": { "config": {...}, "secrets": {...} } }`);
	}
	return local;
}

/**
 * Realms from ws-pubsub-admin over one persistent WebSocket (admin's
 * /agent/v1): a snapshot on connect, then each change as it happens. The
 * last snapshot keeps serving while admin is unreachable.
 *
 * get(id) resolves to
 *   null                    not registered
 *   { realm, secrets }      registered
 *   { realm, error }        registered but unusable (secrets can't be opened)
 * or throws RegistryUnavailable (admin never reached since start).
 *
 * check(id, info) asks admin about one browser connection:
 *   { allow, code?, reason? }. Admin unreachable or slow: allowed on the
 *   local settings ({ allow: true, unchecked: true }), or refused if
 *   requireCheck.
 *
 * options: url (ws(s)://admin/agent/v1), token, local (loadLocalRealms),
 *   gatewayId, version, checkTimeoutMs, requireCheck, readyTimeoutMs,
 *   maxRetryDelay
 */
export function createAdminRegistry(options) {
	const { url, token, local = {}, gatewayId, version = 'unknown' } = options;
	const checkTimeoutMs = options.checkTimeoutMs ?? 3000;
	const maxRetryDelay = options.maxRetryDelay ?? 30000;

	let realms = null; // Map id -> realm, from the last snapshot
	let ws = null;
	let connected = false;
	let closed = false;
	let attempt = 0;
	const pending = new Map(); // req_id -> { resolve, timer }

	let markReady;
	const ready = new Promise(resolve => { markReady = resolve; });
	setTimeout(markReady, options.readyTimeoutMs ?? 5000).unref?.();

	const settle = (req_id, verdict) => {
		const p = pending.get(req_id);
		if(p) {
			clearTimeout(p.timer);
			pending.delete(req_id);
			p.resolve(verdict);
		}
	};
	const unchecked = () => (options.requireCheck
		? { allow: false, code: 1011, reason: 'Realm registry unavailable, try again' }
		: { allow: true, unchecked: true });

	// Token revoked or wrong: this gateway may no longer serve these realms
	const forget = () => {
		if(realms) debug('token refused: dropping', realms.size, 'realms');
		realms = null;
		markReady();
	};

	const connect = () => {
		if(closed) return;
		ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 10000 });
		ws.on('open', () => {
			connected = true;
			attempt = 0;
			debug('connected to', url);
			ws.send(JSON.stringify({ type: 'hello', gateway_id: gatewayId, version, hostname: os.hostname() }));
		});
		ws.on('message', raw => {
			let msg;
			try {
				msg = JSON.parse(raw);
			} catch {
				return;
			}
			if(msg.type === 'snapshot') {
				realms = new Map(msg.realms.map(r => [r.id, r]));
				debug('snapshot:', realms.size, 'realms');
				markReady();
			} else if(msg.type === 'upsert' && realms) {
				realms.set(msg.realm.id, msg.realm);
				debug('upsert', msg.realm.id, msg.realm.revision);
			} else if(msg.type === 'remove' && realms) {
				realms.delete(msg.id);
				debug('remove', msg.id);
			} else if(msg.type === 'check_result') {
				settle(msg.req_id, { allow: Boolean(msg.allow), code: msg.code, reason: msg.reason });
			}
		});
		ws.on('unexpected-response', (req, res) => {
			debug('admin refused the connection: HTTP', res.statusCode, res.statusCode === 401 ? '(check WSPA_TOKEN)' : '');
			if(res.statusCode === 401) forget();
			req.destroy();
		});
		ws.on('error', err => debug('admin connection error:', err.message));
		ws.on('close', (code, reason) => {
			if(connected) debug('disconnected from admin:', code, String(reason));
			if(code === 4401) forget();
			// Never reached: don't keep connections waiting for it
			if(!realms) markReady();
			connected = false;
			for(const req_id of [...pending.keys()]) settle(req_id, unchecked());
			if(closed) return;
			attempt++;
			setTimeout(connect, Math.min(attempt * 1000, maxRetryDelay)).unref?.();
		});
	};
	connect();

	return {
		ready: () => ready,
		connected: () => connected,

		async get(id) {
			await ready;
			if(!realms) {
				throw new RegistryUnavailable('admin not reached yet');
			}
			const realm = realms.get(id);
			if(!realm) {
				return null;
			}
			const mine = local[id] || {};
			const merged = {
				...realm,
				backend: realm.backend && { ...realm.backend, config: { ...realm.backend.config, ...(mine.config || {}) } },
			};
			const secrets = { ...(realm.secrets || {}), ...(mine.secrets || {}) };
			if(realm.secrets_error && !mine.secrets) {
				return { realm: merged, error: 'Realm secrets cannot be opened' };
			}
			return { realm: merged, secrets };
		},

		check(id, info = {}) {
			if(!connected) {
				return Promise.resolve(unchecked());
			}
			return new Promise(resolve => {
				const req_id = crypto.randomUUID();
				const timer = setTimeout(() => settle(req_id, unchecked()), checkTimeoutMs);
				pending.set(req_id, { resolve, timer });
				try {
					ws.send(JSON.stringify({ type: 'check', req_id, realm: id, ...info }));
				} catch {
					settle(req_id, unchecked());
				}
			});
		},

		async close() {
			closed = true;
			try { ws?.close(); } catch {}
		},
	};
}
