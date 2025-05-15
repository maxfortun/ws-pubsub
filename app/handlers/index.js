import Debug from 'debug';
const debug = Debug('ws-pubsub:handlers:index');

// socket close
const close = ({socket, data}) => {
	debug('Backend requested connection close', data);
	socket.close();
};

// metadata set
const set_meta = ({socket, data}) => {
	debug('Backend set metadata', data);
	if(!socket.meta) {
		socket.meta = {};
	}
	Object.assign(socket.meta, data.meta); 
};

export default {
	close,
	set_meta
};

