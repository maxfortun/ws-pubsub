import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { decodeFrame, encodeFrame } from '../pubsub/frames.js';

// What a backend sees: the envelope after a JSON round trip
const roundTrip = encoded => JSON.parse(JSON.stringify(encoded));

describe('frames', () => {
	const text = Buffer.from(JSON.stringify({ meta: { type: 'chat' }, data: { text: 'héllo ✓ "quoted"' } }));
	const binary = Buffer.from([0, 1, 2, 250, 255, 0x80]);

	it('text frames are strings, binary frames base64; both decode to the same bytes', () => {
		const t = roundTrip(encodeFrame(text, false));
		assert.equal(t.encoding, 'utf8');
		assert.equal(typeof t.message, 'string');
		assert.deepEqual(decodeFrame(t), text);
		const b = roundTrip(encodeFrame(binary, true));
		assert.equal(b.encoding, 'base64');
		assert.deepEqual(decodeFrame(b), binary);
	});

	it('old backends (Buffer.from(message)) still read text, and binary in buffer mode', () => {
		assert.deepEqual(Buffer.from(roundTrip(encodeFrame(text, false)).message), text);
		const legacy = roundTrip(encodeFrame(binary, true, 'buffer'));
		assert.equal(legacy.message.type, 'Buffer');
		assert.deepEqual(Buffer.from(legacy.message), binary);
		assert.deepEqual(decodeFrame({ message: legacy.message }), binary, 'no encoding field: as before');
	});

	it('is much smaller than a serialized Buffer', () => {
		const big = crypto.randomBytes(64 * 1024);
		const size = e => JSON.stringify(e).length;
		assert.ok(size(encodeFrame(big, true)) < size({ message: big }) / 2.5);
		assert.ok(size(encodeFrame(text, false)) < size({ message: text }) / 2);
	});
});
