/**
 * FLASH signaling + auth + friends + chat API
 * Media never touches this server (WebRTC P2P only).
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const adminStore = require('./admin-store');

const PORT = process.env.PORT || 8080;
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';
const OTP_ECHO = process.env.OTP_ECHO !== '0'; // return OTP in JSON for easy testing
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
/** Soft cap for concurrent WebSocket clients on this instance */
const MAX_WS = Number(process.env.MAX_WS || 2000);

const rooms = new Map();
const MAX_PEERS = 2;
let waitingPeer = null;

/** @type {Map<string, {id:string,email:string,name:string,picture?:string,friends:Set<string>,createdAt:number}>} */
const usersByEmail = new Map();
/** @type {Map<string, string>} userId -> email */
const emailById = new Map();
/** @type {Map<string, {userId:string,expires:number}>} */
const sessions = new Map();
/** @type {Map<string, {otp:string,expires:number}>} */
const otps = new Map();
/** @type {Map<string, {id:string,from:string,to:string,status:string}>} */
const friendRequests = new Map();
/** @type {Map<string, {id:string,from:string,to:string,text:string,at:number}[]>} */
const chats = new Map(); // key: sorted pair id

function uid() {
  return crypto.randomUUID();
}

function token() {
  return crypto.randomBytes(24).toString('hex');
}

function chatKey(a, b) {
  return [a, b].sort().join(':');
}

function getUserFromAuth(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const s = sessions.get(t);
  if (!s || s.expires < Date.now()) return null;
  const email = emailById.get(s.userId);
  const user = email ? usersByEmail.get(email) : null;
  if (user && isUserBanned(user)) return null;
  return user;
}

function isUserBanned(user) {
  if (!user) return false;
  return !!adminStore.isBanned({ email: user.email, userId: user.id });
}

function invalidateSessionsForUser(userId) {
  for (const [tok, s] of sessions.entries()) {
    if (s.userId === userId) sessions.delete(tok);
  }
  for (const client of wss.clients) {
    if (client.userId === userId) {
      try {
        send(client, { type: 'error', reason: 'banned' });
        client.close(4003, 'banned');
      } catch (_) {}
    }
  }
}

function isAdmin(req) {
  if (!ADMIN_SECRET) return false;
  const h = req.headers['x-flash-admin'] || '';
  const auth = req.headers.authorization || '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return t === ADMIN_SECRET || h === ADMIN_SECRET;
}

function adminOnly(req, res) {
  if (!ADMIN_SECRET) {
    json(res, 503, {
      error: 'Admin disabled — set ADMIN_SECRET on the server',
    });
    return false;
  }
  if (!isAdmin(req)) {
    json(res, 401, { error: 'invalid admin key' });
    return false;
  }
  return true;
}

function ensureUser({ email, name, picture }) {
  const key = email.toLowerCase();
  let u = usersByEmail.get(key);
  if (!u) {
    u = {
      id: uid(),
      email: key,
      name: name || key.split('@')[0],
      picture: picture || '',
      friends: new Set(),
      createdAt: Date.now(),
    };
    usersByEmail.set(key, u);
    emailById.set(u.id, key);
  } else if (name) {
    u.name = name;
    if (picture) u.picture = picture;
  }
  return u;
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    picture: u.picture || '',
  };
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function json(res, code, body) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function verifyGoogleIdToken(idToken) {
  const url =
    'https://oauth2.googleapis.com/tokeninfo?id_token=' +
    encodeURIComponent(idToken);
  const r = await fetch(url);
  if (!r.ok) throw new Error('invalid google token');
  const data = await r.json();
  if (GOOGLE_CLIENT_ID && data.aud !== GOOGLE_CLIENT_ID) {
    throw new Error('google client mismatch');
  }
  if (!data.email || data.email_verified === 'false') {
    throw new Error('email not verified');
  }
  return data;
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (path === '/health') {
      return json(res, 200, {
        ok: true,
        rooms: rooms.size,
        waiting: waitingPeer ? 1 : 0,
        users: usersByEmail.size,
        connections: wss.clients.size,
        maxWs: MAX_WS,
      });
    }

    if (path === '/api/auth/request-otp' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '')
        .trim()
        .toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(res, 400, { error: 'invalid email' });
      }
      const otp = String(Math.floor(100000 + Math.random() * 900000));
      otps.set(email, { otp, expires: Date.now() + 10 * 60 * 1000 });
      console.log(`[otp] ${email} => ${otp}`);
      return json(res, 200, {
        ok: true,
        message: 'OTP generated',
        ...(OTP_ECHO ? { demoOtp: otp } : {}),
      });
    }

    if (path === '/api/auth/verify-otp' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '')
        .trim()
        .toLowerCase();
      const code = String(body.otp || '').trim();
      const entry = otps.get(email);
      if (!entry || entry.expires < Date.now() || entry.otp !== code) {
        return json(res, 401, { error: 'invalid or expired otp' });
      }
      otps.delete(email);
      const banned = adminStore.isBanned({ email });
      if (banned) {
        return json(res, 403, {
          error: banned.reason || 'This account is suspended',
        });
      }
      const user = ensureUser({
        email,
        name: body.name || email.split('@')[0],
      });
      const t = token();
      sessions.set(t, {
        userId: user.id,
        expires: Date.now() + 30 * 24 * 3600 * 1000,
      });
      return json(res, 200, { token: t, user: publicUser(user) });
    }

    if (path === '/api/auth/google' && req.method === 'POST') {
      const body = await readJson(req);
      const idToken = body.credential || body.idToken;
      if (!idToken) return json(res, 400, { error: 'missing credential' });
      const g = await verifyGoogleIdToken(idToken);
      const banned = adminStore.isBanned({ email: g.email });
      if (banned) {
        return json(res, 403, {
          error: banned.reason || 'This account is suspended',
        });
      }
      const user = ensureUser({
        email: g.email,
        name: g.name || g.email.split('@')[0],
        picture: g.picture,
      });
      const t = token();
      sessions.set(t, {
        userId: user.id,
        expires: Date.now() + 30 * 24 * 3600 * 1000,
      });
      return json(res, 200, { token: t, user: publicUser(user) });
    }

    if (path === '/api/me' && req.method === 'GET') {
      const user = getUserFromAuth(req);
      if (!user) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { user: publicUser(user) });
    }

    if (path === '/api/friends' && req.method === 'GET') {
      const user = getUserFromAuth(req);
      if (!user) return json(res, 401, { error: 'unauthorized' });
      const list = [...user.friends]
        .map((id) => {
          const e = emailById.get(id);
          return e ? publicUser(usersByEmail.get(e)) : null;
        })
        .filter(Boolean);
      const incoming = [...friendRequests.values()]
        .filter((r) => r.to === user.id && r.status === 'pending')
        .map((r) => ({
          id: r.id,
          from: publicUser(usersByEmail.get(emailById.get(r.from))),
        }));
      const outgoing = [...friendRequests.values()]
        .filter((r) => r.from === user.id && r.status === 'pending')
        .map((r) => ({
          id: r.id,
          to: publicUser(usersByEmail.get(emailById.get(r.to))),
        }));
      return json(res, 200, { friends: list, incoming, outgoing });
    }

    if (path === '/api/friends/request' && req.method === 'POST') {
      const user = getUserFromAuth(req);
      if (!user) return json(res, 401, { error: 'unauthorized' });
      const body = await readJson(req);
      let target = null;
      if (body.userId) {
        const e = emailById.get(body.userId);
        target = e ? usersByEmail.get(e) : null;
      } else {
        const email = String(body.email || '')
          .trim()
          .toLowerCase();
        target = usersByEmail.get(email);
      }
      if (!target) {
        return json(res, 404, {
          error: 'user not found — unhone pehle login kiya hona chahiye',
        });
      }
      if (target.id === user.id) {
        return json(res, 400, { error: 'cannot friend yourself' });
      }
      if (user.friends.has(target.id)) {
        return json(res, 400, { error: 'already friends' });
      }
      const exists = [...friendRequests.values()].some(
        (r) =>
          r.status === 'pending' &&
          ((r.from === user.id && r.to === target.id) ||
            (r.from === target.id && r.to === user.id)),
      );
      if (exists) return json(res, 400, { error: 'request already pending' });
      const id = uid();
      friendRequests.set(id, {
        id,
        from: user.id,
        to: target.id,
        status: 'pending',
      });
      return json(res, 200, { ok: true, requestId: id });
    }

    if (path === '/api/friends/accept' && req.method === 'POST') {
      const user = getUserFromAuth(req);
      if (!user) return json(res, 401, { error: 'unauthorized' });
      const body = await readJson(req);
      const reqId = body.requestId;
      const fr = friendRequests.get(reqId);
      if (!fr || fr.to !== user.id || fr.status !== 'pending') {
        return json(res, 404, { error: 'request not found' });
      }
      fr.status = 'accepted';
      user.friends.add(fr.from);
      const fromEmail = emailById.get(fr.from);
      const fromUser = usersByEmail.get(fromEmail);
      fromUser.friends.add(user.id);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/chat' && req.method === 'GET') {
      const user = getUserFromAuth(req);
      if (!user) return json(res, 401, { error: 'unauthorized' });
      const withId = url.searchParams.get('with');
      if (!withId || !user.friends.has(withId)) {
        return json(res, 403, { error: 'not friends' });
      }
      const key = chatKey(user.id, withId);
      return json(res, 200, { messages: chats.get(key) || [] });
    }

    if (path === '/api/chat' && req.method === 'POST') {
      const user = getUserFromAuth(req);
      if (!user) return json(res, 401, { error: 'unauthorized' });
      const body = await readJson(req);
      const to = body.to;
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!to || !text || !user.friends.has(to)) {
        return json(res, 400, { error: 'invalid chat' });
      }
      const key = chatKey(user.id, to);
      const list = chats.get(key) || [];
      const msg = {
        id: uid(),
        from: user.id,
        to,
        text,
        at: Date.now(),
      };
      list.push(msg);
      if (list.length > 200) list.shift();
      chats.set(key, list);
      // Push to online sockets if bound to user
      for (const client of wss.clients) {
        if (client.userId === to && client.readyState === 1) {
          send(client, { type: 'chat', message: msg });
        }
      }
      return json(res, 200, { message: msg });
    }

    if (path === '/api/app-config' && req.method === 'GET') {
      return json(res, 200, { config: adminStore.getPublicConfig() });
    }

    if (path === '/api/report' && req.method === 'POST') {
      const body = await readJson(req);
      const reason = String(body.reason || '').trim();
      if (!reason) return json(res, 400, { error: 'reason required' });
      const reporter = getUserFromAuth(req);
      const report = adminStore.addReport({
        id: uid(),
        reporterId: reporter?.id || '',
        reporterEmail: reporter?.email || String(body.reporterEmail || '').trim(),
        reportedUserId: String(body.reportedUserId || '').trim(),
        reportedEmail: String(body.reportedEmail || '').trim().toLowerCase(),
        reason,
        context: body.context || 'call',
        room: String(body.room || '').trim(),
      });
      console.log('[report]', report.id, report.reportedEmail || report.reportedUserId);
      return json(res, 200, { ok: true, id: report.id });
    }

    if (path.startsWith('/api/admin/')) {
      if (!adminOnly(req, res)) return;

      if (path === '/api/admin/stats' && req.method === 'GET') {
        const pendingReports = adminStore
          .listReports('pending')
          .length;
        return json(res, 200, {
          connections: wss.clients.size,
          rooms: rooms.size,
          waiting: waitingPeer ? 1 : 0,
          users: usersByEmail.size,
          pendingReports,
          maxWs: MAX_WS,
        });
      }

      if (path === '/api/admin/config') {
        if (req.method === 'GET') {
          return json(res, 200, { config: adminStore.getPublicConfig() });
        }
        if (req.method === 'PATCH' || req.method === 'POST') {
          const body = await readJson(req);
          const config = adminStore.setConfig(body);
          return json(res, 200, { config });
        }
      }

      if (path === '/api/admin/reports' && req.method === 'GET') {
        const status = url.searchParams.get('status') || '';
        const reports = adminStore.listReports(status || null);
        return json(res, 200, { reports });
      }

      const resolveMatch = path.match(
        /^\/api\/admin\/reports\/([^/]+)\/resolve$/,
      );
      if (resolveMatch && req.method === 'POST') {
        const body = await readJson(req);
        const status = body.status || 'resolved';
        const r = adminStore.resolveReport(resolveMatch[1], status, body.note);
        if (!r) return json(res, 404, { error: 'report not found' });
        if (body.banReported) {
          const email = r.reportedEmail;
          const userId = r.reportedUserId;
          if (email || userId) {
            adminStore.banUser({
              email,
              userId,
              reason: 'Report: ' + (r.reason || '').slice(0, 200),
              by: 'admin',
            });
            if (userId) invalidateSessionsForUser(userId);
            else if (email) {
              const u = usersByEmail.get(email.toLowerCase());
              if (u) invalidateSessionsForUser(u.id);
            }
          }
        }
        return json(res, 200, { ok: true, report: r });
      }

      if (path === '/api/admin/users' && req.method === 'GET') {
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        let list = [...usersByEmail.values()].map((u) => ({
          ...publicUser(u),
          createdAt: u.createdAt,
          banned: !!adminStore.isBanned({ email: u.email, userId: u.id }),
        }));
        if (q) {
          list = list.filter(
            (u) =>
              u.email.includes(q) ||
              (u.name || '').toLowerCase().includes(q) ||
              u.id.includes(q),
          );
        }
        list.sort((a, b) => b.createdAt - a.createdAt);
        return json(res, 200, { users: list.slice(0, 100) });
      }

      if (path === '/api/admin/bans' && req.method === 'GET') {
        return json(res, 200, { bans: adminStore.listBans() });
      }

      if (path === '/api/admin/users/ban' && req.method === 'POST') {
        const body = await readJson(req);
        const email = String(body.email || '').trim().toLowerCase();
        let userId = String(body.userId || '').trim();
        if (!email && !userId) {
          return json(res, 400, { error: 'email or userId required' });
        }
        if (email && !userId) {
          const u = usersByEmail.get(email);
          if (u) userId = u.id;
        }
        const entry = adminStore.banUser({
          email,
          userId,
          reason: body.reason,
          by: 'admin',
        });
        if (userId) invalidateSessionsForUser(userId);
        return json(res, 200, { ok: true, ban: entry });
      }

      if (path === '/api/admin/users/unban' && req.method === 'POST') {
        const body = await readJson(req);
        const ok = adminStore.unbanUser({
          email: body.email,
          userId: body.userId,
        });
        if (!ok) return json(res, 404, { error: 'ban not found' });
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'unknown admin route' });
    }

    json(res, 200, {
      ok: true,
      service: 'flash-signaling',
      tip: 'Connect via WebSocket; REST under /api/*',
    });
  } catch (e) {
    console.error(e);
    json(res, 500, { error: e.message || 'server error' });
  }
});

const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
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
    if (room.size === 0) rooms.delete(roomCode);
    else {
      for (const [, peerWs] of room) {
        send(peerWs, { type: 'peer-left', peerId });
      }
    }
  }
  ws.roomCode = null;
}

function peerProfile(ws) {
  if (!ws.userId) return null;
  const email = emailById.get(ws.userId);
  const u = email ? usersByEmail.get(email) : null;
  return u ? publicUser(u) : null;
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
    send(other, {
      type: 'matched',
      peerId: other.peerId,
      initiator: false,
      peer: peerProfile(ws),
      room: roomCode,
    });
    send(ws, {
      type: 'matched',
      peerId: ws.peerId,
      initiator: true,
      peer: peerProfile(other),
      room: roomCode,
    });
    console.log(`[match] ${other.peerId} <-> ${ws.peerId}`);
  } else {
    waitingPeer = ws;
    send(ws, { type: 'waiting' });
  }
}

wss.on('connection', (ws) => {
  if (wss.clients.size > MAX_WS) {
    try {
      ws.send(JSON.stringify({ type: 'error', message: 'Server busy — try again' }));
    } catch (_) {}
    ws.close(1013, 'busy');
    return;
  }

  ws.peerId = uid();
  ws.isAlive = true;
  ws.userId = null;
  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'auth': {
        const s = sessions.get(msg.token || '');
        if (s && s.expires > Date.now()) {
          const email = emailById.get(s.userId);
          const u = email ? usersByEmail.get(email) : null;
          if (u && isUserBanned(u)) {
            send(ws, { type: 'auth-fail', reason: 'banned' });
            ws.close(4003, 'banned');
            break;
          }
          ws.userId = s.userId;
          send(ws, { type: 'auth-ok', peerId: ws.peerId, userId: ws.userId });
        } else {
          send(ws, { type: 'auth-fail' });
        }
        break;
      }

      case 'join': {
        const cfgJoin = adminStore.getPublicConfig();
        if (cfgJoin.maintenance) {
          send(ws, {
            type: 'error',
            reason: 'maintenance',
            message: cfgJoin.maintenanceMessage,
          });
          return;
        }
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
        if (room.size >= MAX_PEERS) {
          send(ws, { type: 'room-full' });
          return;
        }
        room.set(ws.peerId, ws);
        ws.roomCode = roomCode;
        const isInitiator = room.size === MAX_PEERS;
        send(ws, {
          type: 'joined',
          peerId: ws.peerId,
          initiator: isInitiator,
          peer: isInitiator
            ? peerProfile([...room.values()].find((p) => p.peerId !== ws.peerId))
            : null,
          room: roomCode,
        });
        for (const [, peerWs] of otherPeers(roomCode, ws.peerId)) {
          send(peerWs, {
            type: 'peer-joined',
            peerId: ws.peerId,
            peer: peerProfile(ws),
          });
        }
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice': {
        if (!ws.roomCode) return;
        for (const [, peerWs] of otherPeers(ws.roomCode, ws.peerId)) {
          send(peerWs, {
            type: msg.type,
            payload: msg.payload,
            from: ws.peerId,
          });
        }
        break;
      }

      case 'chat-room': {
        // Text chat while in a random/private call room
        if (!ws.roomCode) return;
        const text = String(msg.text || '').trim().slice(0, 500);
        if (!text) return;
        for (const [, peerWs] of otherPeers(ws.roomCode, ws.peerId)) {
          send(peerWs, {
            type: 'chat-room',
            text,
            from: ws.peerId,
            at: Date.now(),
          });
        }
        break;
      }

      case 'find': {
        const cfg = adminStore.getPublicConfig();
        if (cfg.maintenance) {
          send(ws, {
            type: 'error',
            reason: 'maintenance',
            message: cfg.maintenanceMessage,
          });
          return;
        }
        if (cfg.randomMatchEnabled === false) {
          send(ws, { type: 'error', reason: 'random-disabled' });
          return;
        }
        if (ws.roomCode) leaveRoom(ws);
        tryMatch(ws);
        break;
      }

      case 'leave': {
        if (waitingPeer === ws) waitingPeer = null;
        leaveRoom(ws);
        break;
      }

      case 'ping': {
        send(ws, { type: 'pong', t: Date.now() });
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

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 25_000);

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`FLASH server on :${PORT}`);
});
