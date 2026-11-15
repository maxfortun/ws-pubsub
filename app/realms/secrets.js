// Opens secrets sealed by ws-pubsub-admin (its app/src/secrets.js):
//   wspa:enc:v1:<kid>:<base64url(iv | ciphertext | tag)>, AES-256-GCM,
//   additional data "wspa:<realm id>:backend.secrets.<name>".
// The gateway only opens; it needs the admin's SECRETS_KEYS.

import crypto from 'node:crypto';

const PREFIX = 'wspa:enc:v1:';

/** "k1:<base64 32 bytes>,k2:..." -> { k1: Buffer, ... } */
export function parseKeys(spec) {
	const keys = {};
	for(const entry of String(spec || '').split(',').map(s => s.trim()).filter(Boolean)) {
		const i = entry.indexOf(':');
		const key = Buffer.from(entry.slice(i + 1), 'base64');
		if(i < 1 || key.length !== 32) {
			throw new Error('SECRETS_KEYS entries must be <kid>:<base64 of 32 bytes>');
		}
		keys[entry.slice(0, i)] = key;
	}
	return keys;
}

export const secretAad = (realmId, field) => `wspa:${realmId}:backend.secrets.${field}`;

export function openSecret(keys, sealed, aad) {
	if(typeof sealed !== 'string' || !sealed.startsWith(PREFIX)) {
		throw new Error('Not a sealed value');
	}
	const rest = sealed.slice(PREFIX.length);
	const i = rest.indexOf(':');
	const key = keys[rest.slice(0, i)];
	if(!key) {
		throw new Error('Unknown key id');
	}
	const raw = Buffer.from(rest.slice(i + 1), 'base64url');
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
	decipher.setAAD(Buffer.from(aad));
	decipher.setAuthTag(raw.subarray(raw.length - 16));
	return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8');
}
