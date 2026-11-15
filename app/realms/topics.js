// Topic templates, as validated by ws-pubsub-admin (its app/src/topics.js):
// {realm}, {env}, {gateway}, {header.NAME}. Header values come from the
// client, so only safe segments are used; anything else refuses the
// connection rather than building a surprising topic name.

const TOKEN = /\{([a-z]+)(?:\.([a-z0-9-]{1,64}))?\}/g;
export const HEADER_VALUE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Throws an Error with a client-safe message if a value is missing or unsafe */
export function renderTemplate(template, { realm, env, gateway, headers = {} }) {
	return String(template).replace(TOKEN, (token, name, arg) => {
		if(name === 'header') {
			const value = headers[arg];
			if(value === undefined) {
				throw new Error(`Missing header ${arg}`);
			}
			if(!HEADER_VALUE.test(value)) {
				throw new Error(`Header ${arg} must be 1-64 of A-Z a-z 0-9 _ . -`);
			}
			return value;
		}
		const value = { realm, env, gateway }[name];
		if(value === undefined) {
			throw new Error(`No value for ${token}`);
		}
		return value;
	});
}
