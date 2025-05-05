import Debug from 'debug';
const debug = Debug('ws-pubsub:handlers:index');

// socket close
const c = ({socket, data}) => {
	debug('Backend requested connection close', data);
	socket.close();
};

// metadata set
const mds = ({socket, data}) => {
	debug('Backend set metadata', data);
	if(!socket.meta) {
		socket.meta = {};
	}
	Object.assign(socket.meta, data.md); 
};

export default {
	c,
	mds
};

