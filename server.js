'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { tally } = require('./lib/tally');

const PORT = process.env.PORT || 3000;
const HOST_GRACE_MS = Number(process.env.HOST_GRACE_MS) || 20000; // before a missing host is replaced
const ROOM_IDLE_MS = 6 * 60 * 60 * 1000;   // delete rooms nobody has touched for 6 hours
const ROOM_EMPTY_MS = 30 * 60 * 1000;      // delete rooms with nobody connected for 30 minutes

const MODES = ['pick', 'ranked', 'swipe', 'veto'];
const LIMITS = { title: 80, name: 24, option: 60, options: 30, members: 60, rooms: 3000 };
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)

/** code -> room. Everything lives in memory: rooms are short-lived by design. */
const rooms = new Map();

// ---------------------------------------------------------------- helpers

function clean(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function randomId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function makeCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(5), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  } while (rooms.has(code));
  return code;
}

function normaliseCode(value) {
  return typeof value === 'string' ? value.trim().toUpperCase().slice(0, 8) : '';
}

function validKey(key) {
  return typeof key === 'string' && key.length >= 16 && key.length <= 64;
}

function isConnected(member) {
  return member.sockets.size > 0;
}

function memberById(room, id) {
  for (const m of room.members.values()) if (m.id === id) return m;
  return null;
}

function touch(room) {
  room.lastActivity = Date.now();
}

function stateFor(room, me) {
  return {
    code: room.code,
    title: room.title,
    mode: room.mode,
    vetoesPer: room.vetoesPer,
    phase: room.phase,
    round: room.round,
    hostId: room.hostId,
    you: me.id,
    members: [...room.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      connected: isConnected(m),
      voted: room.ballots.has(m.id),
    })),
    options: room.options,
    myBallot: room.ballots.get(me.id) || null,
    result: room.result,
  };
}

function broadcast(room) {
  for (const member of room.members.values()) {
    if (!isConnected(member)) continue;
    const state = stateFor(room, member);
    for (const socketId of member.sockets) io.to(socketId).emit('room:state', state);
  }
}

/** How many vetoes each voter really gets: never enough to strike everything. */
function vetoAllowance(room) {
  return Math.max(0, Math.min(room.vetoesPer, room.options.length - 1));
}

/** Returns a clean ballot for the room's voting style, or null if invalid. */
function validateBallot(room, ballot) {
  const ids = room.options.map((o) => o.id);
  if (room.mode === 'pick') {
    return typeof ballot === 'string' && ids.includes(ballot) ? ballot : null;
  }
  if (room.mode === 'ranked') {
    if (!Array.isArray(ballot) || ballot.length !== ids.length) return null;
    if (new Set(ballot).size !== ids.length) return null;
    if (!ballot.every((id) => ids.includes(id))) return null;
    return ballot.slice();
  }
  if (room.mode === 'swipe') {
    if (!ballot || typeof ballot !== 'object' || Array.isArray(ballot)) return null;
    const out = {};
    for (const id of ids) {
      if (typeof ballot[id] !== 'boolean') return null;
      out[id] = ballot[id];
    }
    return out;
  }
  if (room.mode === 'veto') {
    if (!Array.isArray(ballot) || ballot.length > vetoAllowance(room)) return null;
    if (new Set(ballot).size !== ballot.length) return null;
    if (!ballot.every((id) => ids.includes(id))) return null;
    return ballot.slice();
  }
  return null;
}

function reveal(room) {
  const counted = tally(room.mode, room.options, [...room.ballots.values()]);
  const tied = counted.winners.length > 1;
  room.result = {
    ...counted,
    final: tied ? null : counted.winners[0] || null,
    tie: tied ? counted.winners : null,
    wheel: null,
  };
  room.phase = 'result';
}

function reassignHost(room) {
  if (rooms.get(room.code) !== room) return;
  const host = memberById(room, room.hostId);
  if (host && isConnected(host)) return;
  const next = [...room.members.values()].find(isConnected);
  if (next) {
    room.hostId = next.id;
    broadcast(room);
  }
}

// ---------------------------------------------------------------- http

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

// QR code for a room's invite link. Only real rooms get one.
app.get('/qr/:code', async (req, res) => {
  const code = normaliseCode(req.params.code);
  if (!rooms.has(code)) return res.status(404).type('text').send('No such room');
  const base = process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`;
  try {
    const svg = await QRCode.toString(`${base.replace(/\/$/, '')}/r/${code}`, {
      type: 'svg',
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1f1b16', light: '#ffffff' },
    });
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    res.status(500).type('text').send('Could not make the QR code');
  }
});

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { maxAge: '10m', index: false }));

// Link previews (LinkedIn, WhatsApp, Slack) need absolute URLs, so fill in this site's address.
const INDEX_HTML = require('fs').readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

function sendIndex(req, res) {
  const base = (process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(INDEX_HTML.split('__BASE_URL__').join(base));
}
app.get('/', sendIndex);
app.get('/r/:code', sendIndex);
app.use((req, res) => res.redirect('/'));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16 * 1024, serveClient: true });

// ---------------------------------------------------------------- sockets

/** Registers an event handler with rate limiting, input guarding and an ack reply. */
function handle(socket, event, handler) {
  socket.on(event, (payload, ack) => {
    if (typeof payload === 'function') {
      ack = payload;
      payload = {};
    }
    const reply = typeof ack === 'function' ? ack : () => {};

    const now = Date.now();
    const bucket = socket.data.bucket || (socket.data.bucket = { start: now, count: 0 });
    if (now - bucket.start > 5000) {
      bucket.start = now;
      bucket.count = 0;
    }
    if (++bucket.count > 40) return reply({ error: 'Slow down a moment.' });

    try {
      const body = payload && typeof payload === 'object' ? payload : {};
      reply(handler(body) || { ok: true });
    } catch (err) {
      console.error(`Error in ${event}:`, err);
      reply({ error: 'Something went wrong. Try again.' });
    }
  });
}

function leaveCurrentRoom(socket) {
  const room = rooms.get(socket.data.code);
  socket.data.code = null;
  if (!room) return;
  const member = room.members.get(socket.data.key);
  if (!member) return;
  member.sockets.delete(socket.id);
  if (isConnected(member)) return;

  member.lastSeen = Date.now();
  if (member.id === room.hostId) {
    setTimeout(() => reassignHost(room), HOST_GRACE_MS).unref();
  }
  if (![...room.members.values()].some(isConnected)) room.emptySince = Date.now();
  broadcast(room);
}

function joinRoom(socket, room, key, name) {
  let member = room.members.get(key);
  if (!member) {
    if (!name) return { error: 'Enter your name to join.' };
    if (room.members.size >= LIMITS.members) return { error: 'This room is full.' };
    member = { id: randomId(), name, sockets: new Set(), lastSeen: Date.now() };
    room.members.set(key, member);
  } else if (name) {
    member.name = name;
  }

  if (socket.data.code && socket.data.code !== room.code) leaveCurrentRoom(socket);
  member.sockets.add(socket.id);
  socket.data.code = room.code;
  socket.data.key = key;
  room.emptySince = null;

  // Take over if the room has no host, or the host has been gone a while.
  const host = memberById(room, room.hostId);
  if (!host || (!isConnected(host) && Date.now() - host.lastSeen > HOST_GRACE_MS)) {
    room.hostId = member.id;
  }

  touch(room);
  broadcast(room);
  return { ok: true, state: stateFor(room, member) };
}

/** The room and member behind a socket, plus whether that member is the host. */
function context(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return null;
  const member = room.members.get(socket.data.key);
  if (!member) return null;
  return { room, member, isHost: member.id === room.hostId };
}

const NOT_IN_ROOM = { error: 'You are not in this room any more. Refresh the page.' };
const HOST_ONLY = { error: 'Only the host can do that.' };

io.on('connection', (socket) => {
  handle(socket, 'room:create', (body) => {
    if (!validKey(body.key)) return { error: 'Refresh the page and try again.' };
    const name = clean(body.name, LIMITS.name);
    if (!name) return { error: 'Enter your name.' };
    if (rooms.size >= LIMITS.rooms) return { error: 'The server is busy. Try again in a few minutes.' };
    socket.data.created = (socket.data.created || 0) + 1;
    if (socket.data.created > 10) return { error: 'You have made a lot of rooms. Refresh to make more.' };

    const room = {
      code: makeCode(),
      title: clean(body.title, LIMITS.title) || 'What should we pick?',
      mode: MODES.includes(body.mode) ? body.mode : 'pick',
      vetoesPer: 1,
      phase: 'collect',
      round: 1,
      hostId: null,
      members: new Map(),
      options: [],
      ballots: new Map(),
      result: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      emptySince: null,
    };
    rooms.set(room.code, room);
    const joined = joinRoom(socket, room, body.key, name);
    return { ...joined, code: room.code };
  });

  handle(socket, 'room:peek', (body) => {
    const room = rooms.get(normaliseCode(body.code));
    if (!room) return { ok: true, exists: false };
    return {
      ok: true,
      exists: true,
      title: room.title,
      phase: room.phase,
      people: [...room.members.values()].filter(isConnected).map((m) => m.name).slice(0, 12),
      member: validKey(body.key) && room.members.has(body.key),
    };
  });

  handle(socket, 'room:join', (body) => {
    if (!validKey(body.key)) return { error: 'Refresh the page and try again.' };
    const room = rooms.get(normaliseCode(body.code));
    if (!room) return { error: 'That room has ended.', gone: true };
    return joinRoom(socket, room, body.key, clean(body.name, LIMITS.name));
  });

  handle(socket, 'room:leave', () => {
    leaveCurrentRoom(socket);
  });

  handle(socket, 'room:settings', (body) => {
    const ctx = context(socket);
    if (!ctx) return NOT_IN_ROOM;
    if (!ctx.isHost) return HOST_ONLY;
    const { room } = ctx;
    if (room.phase !== 'collect') return { error: 'Settings are locked once voting starts.' };
    if (MODES.includes(body.mode)) room.mode = body.mode;
    if (Number.isInteger(body.vetoesPer) && body.vetoesPer >= 1 && body.vetoesPer <= 3) {
      room.vetoesPer = body.vetoesPer;
    }
    const title = clean(body.title, LIMITS.title);
    if (title) room.title = title;
    touch(room);
    broadcast(room);
  });

  handle(socket, 'option:add', (body) => {
    const ctx = context(socket);
    if (!ctx) return NOT_IN_ROOM;
    const { room, member } = ctx;
    if (room.phase !== 'collect') return { error: 'Voting has started, so options are locked.' };
    const text = clean(body.text, LIMITS.option);
    if (!text) return { error: 'Type an option first.' };
    if (room.options.length >= LIMITS.options) return { error: `A room can hold ${LIMITS.options} options.` };
    if (room.options.some((o) => o.text.toLowerCase() === text.toLowerCase())) {
      return { error: 'That option is already on the list.' };
    }
    room.options.push({ id: randomId(4), text, by: member.id });
    touch(room);
    broadcast(room);
  });

  handle(socket, 'option:remove', (body) => {
    const ctx = context(socket);
    if (!ctx) return NOT_IN_ROOM;
    const { room, member, isHost } = ctx;
    if (room.phase !== 'collect') return { error: 'Voting has started, so options are locked.' };
    const option = room.options.find((o) => o.id === body.id);
    if (!option) return { ok: true };
    if (!isHost && option.by !== member.id) return { error: 'You can only remove options you added.' };
    room.options = room.options.filter((o) => o !== option);
    touch(room);
    broadcast(room);
  });

  handle(socket, 'phase:start', () => {
    const ctx = context(socket);
    if (!ctx) return NOT_IN_ROOM;
    if (!ctx.isHost) return HOST_ONLY;
    const { room } = ctx;
    if (room.phase !== 'collect') return { ok: true };
    if (room.options.length < 2) return { error: 'Add at least two options first.' };
    room.phase = 'vote';
    room.ballots.clear();
    touch(room);
    broadcast(room);
  });

  handle(socket, 'vote:submit', (body) => {
    const ctx = context(socket);
    if (!ctx) return NOT_IN_ROOM;
    const { room, member } = ctx;
    if (room.phase !== 'vote') return { error: 'Voting is not open right now.' };
    const ballot = validateBallot(room, body.ballot);
    if (!ballot) return { error: 'That vote did not go through. Try again.' };
    room.ballots.set(member.id, ballot);

    // Everyone here has voted: no reason to keep them waiting.
    const present = [...room.members.values()].filter(isConnected);
    if (present.every((m) => room.ballots.has(m.id))) reveal(room);
    touch(room);
    broadcast(room);
  });

  handle(socket, 'phase:reveal', () => {
    const ctx = context(socket);
    if (!ctx) return NOT_IN_ROOM;
    if (!ctx.isHost) return HOST_ONLY;
    const { room } = ctx;
    if (room.phase !== 'vote') return { ok: true };
    if (room.ballots.size === 0) return { error: 'Nobody has voted yet.' };
    reveal(room);
    touch(room);
    broadcast(room);
  });

  handle(socket, 'wheel:spin', () => {
    const ctx = context(socket);
    if (!ctx) return NOT_IN_ROOM;
    if (!ctx.isHost) return HOST_ONLY;
    const { room } = ctx;
    const result = room.result;
    if (room.phase !== 'result' || !result || !result.tie || result.wheel) return { ok: true };
    const winnerId = result.tie[crypto.randomInt(result.tie.length)];
    result.wheel = {
      spinId: randomId(4),
      candidates: result.tie,
      winnerId,
      // Where inside the winning slice the pointer lands, so every screen matches.
      offset: (crypto.randomInt(700) - 350) / 1000,
    };
    result.final = winnerId;
    touch(room);
    broadcast(room);
  });

  handle(socket, 'room:reset', (body) => {
    const ctx = context(socket);
    if (!ctx) return NOT_IN_ROOM;
    if (!ctx.isHost) return HOST_ONLY;
    const { room } = ctx;
    room.phase = 'collect';
    room.round += 1;
    room.ballots.clear();
    room.result = null;
    if (!body.keepOptions) room.options = [];
    const title = clean(body.title, LIMITS.title);
    if (title) room.title = title;
    touch(room);
    broadcast(room);
  });

  socket.on('disconnect', () => leaveCurrentRoom(socket));
});

// ---------------------------------------------------------------- cleanup

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = now - room.lastActivity > ROOM_IDLE_MS;
    const empty = room.emptySince && now - room.emptySince > ROOM_EMPTY_MS;
    if (idle || empty) rooms.delete(code);
  }
}, 60 * 1000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log(`Settle is running on http://localhost:${PORT}`));
}

module.exports = { server, io, rooms };
