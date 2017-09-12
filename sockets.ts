//@ts-check
import socketIO = require('socket.io');
import uuid = require('node-uuid');
import crypto = require('crypto');

module.exports = function (server, config) {
    let io = socketIO.listen(server);

    io.sockets.on('connection', function (client) {
        console.log("on connection", client.id);
        client.resources = {
            screen: false,
            video: true,
            audio: false
        };

        // pass a message to another id
        client.on('message', function (details) {
            if (!details) return;

            let otherClient = io.to(details.to);
            if (!otherClient) return;

            details.from = client.id;
            otherClient.emit('message', details);
        });

        client.on('shareScreen', function () {
            client.resources.screen = true;
        });

        client.on('unshareScreen', function (type) {
            client.resources.screen = false;
            removeFeed('screen');
        });

        client.on('join', join);

        function removeFeed(type?: string) {
            if (client.room) {
                io.sockets.in(client.room).emit('remove', {
                    id: client.id,
                    type: type
                });
                if (!type) {
                    client.leave(client.room);
                    client.room = undefined;
                }
            }
        }

        function join(name: string, cb: Function) {
            console.log("Join-room", name);
            // sanity check
            if (typeof name !== 'string') return;
            // check if maximum number of clients reached
            if (config.rooms && config.rooms.maxClients > 0 &&
                clientsInRoom(name) >= config.rooms.maxClients) {
                safeCb(cb)('full');
                return;
            }
            // leave any existing rooms
            removeFeed();
            safeCb(cb)(null, describeRoom(name));
            client.join(name);
            client.room = name;
        }

        // we don't want to pass "leave" directly because the
        // event type string of "socket end" gets passed too.
        client.on('disconnect', function () {
            removeFeed();
        });
        client.on('leave', function () {
            removeFeed();
        });

        client.on('create', function (name: string, cb: Function) {
            name = name || uuid();

            // check if exists
            let room = io.nsps['/'].adapter.rooms[name];
            if (room && room.length) {
                safeCb(cb)('taken');
            } else {
                join(name, () => { console.log("join callback") });
                safeCb(cb)(null, name);
            }
        });

        // support for logging full webrtc traces to stdout
        // useful for large-scale error monitoring
        client.on('trace', function (data) {
            console.log('trace', JSON.stringify(
                [data.type, data.session, data.prefix, data.peer, data.time, data.value]
            ));
        });


        // tell client about stun and turn servers and generate nonces
        client.emit('stunservers', config.stunservers || []);

        // create shared secret nonces for TURN authentication
        // the process is described in draft-uberti-behave-turn-rest
        let credentials = [];
        // allow selectively vending turn credentials based on origin.
        let origin = client.handshake.headers.origin;
        if (!config.turnorigins || config.turnorigins.indexOf(origin) !== -1) {
            config.turnservers.forEach(function (server) {
                // var hmac = crypto.createHmac('sha1', server.secret);
                // default to 86400 seconds timeout unless specified
                // var username = Math.floor(new Date().getTime() / 1000) + (parseInt(server.expiry || 86400, 10)) + "";
                // hmac.update(username);
                credentials.push({
                    username: server.username,
                    credential: server.credential,
                    urls: server.urls || server.url
                });
            });
        }
        client.emit('turnservers', credentials);
    });

    function describeRoom(name: string) {
        let result = {
            clients: {}
        };
        try {
            let adapter = io.nsps['/'].adapter;
            let clients = adapter.rooms[name] || {};

            for (let key in clients) {
                if (clients.hasOwnProperty(key)) {
                    let element = clients[key];
                    for (let key2 in element) {
                        if (element.hasOwnProperty(key2)) {
                            result.clients[key2] = adapter.nsp.connected[key2].resources;
                        }
                    }
                }
            }
        }
        catch (ex) {
            console.warn("describeRoom", ex.message);
        }
        finally {
            return result;
        }
    }

    function clientsInRoom(name) {
        return io.sockets.clients(name).length;
    }
};

function safeCb(cb) {
    if (typeof cb === 'function') {
        return cb;
    } else {
        return function () { };
    }
}
