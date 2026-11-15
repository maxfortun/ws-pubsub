// Message lifetimes. A stream entry's id is its creation time in ms, so
// trimming with MINID drops everything older than a TTL - enforced by Redis
// whether or not the consuming backend knows about it.

const UNITS = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 };

/** "90s", "5m", "1h", "2d", "500ms" or plain ms -> ms; null if invalid */
export function parseDuration(text) {
	const match = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
	if(!match) {
		return null;
	}
	const ms = Math.round(parseFloat(match[1]) * UNITS[match[2] || 'ms']);
	return ms > 0 ? ms : null;
}

/**
 * "dating=5m, chat=1d, default=1h" -> lookup(realm) -> ttl in ms.
 * Realms not listed get `default` (or `fallbackMs`). Invalid entries are
 * reported through `warn` and ignored.
 */
export function realmTtls(spec, fallbackMs, warn = () => {}) {
	const ttls = {};
	for(const entry of String(spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
		const [realm, value] = entry.split('=').map(s => s?.trim());
		const ms = parseDuration(value);
		if(!realm || !ms) {
			warn(`Ignoring realm TTL "${entry}"`);
			continue;
		}
		ttls[realm] = ms;
	}
	const fallback = ttls.default ?? fallbackMs;
	return realm => ttls[realm] ?? fallback;
}

/**
 * XADD options trimming entries older than ttlMs. Exact, not approximate
 * (~): approximate trimming only removes whole internal nodes (~100
 * entries), so a quiet realm would keep expired messages around.
 */
export const trimOlderThan = (ttlMs, now = Date.now()) => ({
	TRIM: { strategy: 'MINID', threshold: `${Math.max(0, now - ttlMs)}-0` },
});
