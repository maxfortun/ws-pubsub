// How client frames travel in the envelope's `message` field

/**
 * A client frame for the envelope. Text frames (valid UTF-8, ws checks) go
 * as strings: Buffer.from(message) gives back the same bytes. Binary frames
 * go as base64, or - for backends that predate `encoding` - as a
 * serialized Buffer ({ type: 'Buffer', data: [...] }, ~3.6x the size).
 */
export function encodeFrame(frame, isBinary, binaryEncoding = 'base64') {
	if(!isBinary) {
		return { message: frame.toString('utf8'), encoding: 'utf8' };
	}
	if(binaryEncoding === 'buffer') {
		return { message: frame, encoding: 'buffer' };
	}
	return { message: frame.toString('base64'), encoding: 'base64' };
}

/** The frame's bytes back, for any `encoding` (absent: a serialized Buffer) */
export function decodeFrame({ message, encoding }) {
	return encoding === 'base64' ? Buffer.from(message, 'base64') : Buffer.from(message);
}
