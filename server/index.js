/**
 * Signaling server for 1:1 WebRTC video calls.
 *
 * IMPORTANT: This server NEVER sees any audio/video data.
 * It only relays small text messages (SDP offers/answers and ICE candidates)
 * so that two phones can find each other. The actual call is peer-to-peer
 * and encrypted end-to-end with DTLS-SRTP (mandatory in WebRTC).
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

// roomCode -> Map<peerId, ws>
const rooms = new Map();
const MAX_PEERS_PER_ROOM = 2;

// Random matchmaking queue (OmeTV style): one peer waits until another arrives.
let waitingPeer = null;

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Signaling server running. Connect via WebSocket.');
});

const wss = new WebSocketServer({ server });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function otherPeers(roomCode, exceptId) {
  const room = rooms.get(roomCode);
  if (!room) return [];
  return [...room.entries()].filter(([id]) => id !== exceptId);
}

function leaveRoom(ws) {
  const { roomCode, peerId } = ws;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (room) {
    room.delete(peerId);
    if (room.size === 0) {
      rooms.delete(roomCode);
    } else {
      for (const [, peerWs] of room) {
        send(peerWs, { type: 'peer-left', peerId });
      }
    }
  }
  ws.roomCode = null;
  console.log(`[leave] peer=${peerId} room=${roomCode} (rooms alive: ${rooms.size})`);
}

function tryMatch(ws) {
  if (waitingPeer === ws) return;
  if (waitingPeer && waitingPeer.readyState === waitingPeer.OPEN) {
    const other = waitingPeer;
    waitingPeer = null;

    const roomCode = 'RND-' + crypto.randomBytes(4).toString('hex').toUpperCase();
    const room = new Map([
      [other.peerId, other],
      [ws.peerId, ws],
    ]);
    rooms.set(roomCode, room);
    other.roomCode = roomCode;
    ws.roomCode = roomCode;

    // The peer that was waiting receives the offer; the newcomer creates it.
    send(other, { type: 'matched', peerId: other.peerId, initiator: false });
    send(ws, { type: 'matched', peerId: ws.peerId, initiator: true });
    console.log(`[match] ${other.peerId} <-> ${ws.peerId} room=${roomCode}`);
  } else {
    waitingPeer = ws;
    send(ws, { type: 'waiting' });
    console.log(`[queue] peer=${ws.peerId} waiting for a match`);
  }
}

wss.on('connection', (ws) => {
  ws.peerId = crypto.randomUUID();
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'join': {
        const roomCode = String(msg.room || '').trim().toUpperCase();
        if (!/^[A-Z0-9-]{4,32}$/.test(roomCode)) {
          send(ws, { type: 'error', reason: 'invalid-room-code' });
          return;
        }
        if (ws.roomCode) leaveRoom(ws);

        let room = rooms.get(roomCode);
        if (!room) {
          room = new Map();
          rooms.set(roomCode, room);
        }
        if (room.size >= MAX_PEERS_PER_ROOM) {
          send(ws, { type: 'room-full' });
          return;
        }

        room.set(ws.peerId, ws);
        ws.roomCode = roomCode;

        // The second peer to join becomes the "caller" (creates the offer).
        const isInitiator = room.size === MAX_PEERS_PER_ROOM;
        send(ws, { type: 'joined', peerId: ws.peerId, initiator: isInitiator });

        for (const [id, peerWs] of otherPeers(roomCode, ws.peerId)) {
          send(peerWs, { type: 'peer-joined', peerId: ws.peerId });
        }
        console.log(`[join] peer=${ws.peerId} room=${roomCode} size=${room.size}`);
        break;
      }

      // Relay SDP/ICE to the other peer in the room. Payload is opaque to us.
      case 'offer':
      case 'answer':
      case 'ice': {
        if (!ws.roomCode) return;
        for (const [, peerWs] of otherPeers(ws.roomCode, ws.peerId)) {
          send(peerWs, { type: msg.type, payload: msg.payload, from: ws.peerId });
        }
        break;
      }

      // Random matchmaking: find a stranger (also used as "Next" to skip).
      case 'find': {
        if (ws.roomCode) leaveRoom(ws);
        tryMatch(ws);
        break;
      }

      case 'leave': {
        if (waitingPeer === ws) waitingPeer = null;
        leaveRoom(ws);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (waitingPeer === ws) waitingPeer = null;
    leaveRoom(ws);
  });
  ws.on('error', () => {
    if (waitingPeer === ws) waitingPeer = null;
    leaveRoom(ws);
  });
});

// Kill dead connections so rooms free up (e.g. app killed without 'leave').
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
