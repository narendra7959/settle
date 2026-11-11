'use strict';

// End-to-end tests: start the real server and drive it with real socket clients.

process.env.HOST_GRACE_MS = '50';

const test = require('node:test');
const assert = require('node:assert/strict');
const { io: connect } = require('socket.io-client');
const { server, io } = require('../server');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://localhost:${server.address().port}`;
});

test.after(() => {
  io.close();
  server.close();
});

let keyCounter = 0;
function client(t) {
  const socket = connect(base, { transports: ['websocket'], forceNew: true });
  const key = `test-key-${String(++keyCounter).padStart(12, '0')}`;
  let latest = null;
  socket.on('room:state', (state) => { latest = state; });
  t.after(() => socket.close());
  return {
    key,
    socket,
    state: () => latest,
    send: (event, payload) => socket.timeout(3000).emitWithAck(event, payload || {}),
    /** Waits until the latest room state satisfies `check`. */
    async until(check) {
      for (let i = 0; i < 100; i++) {
        if (latest && check(latest)) return latest;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Timed out waiting for room state');
    },
  };
}

async function roomWith(t, mode, optionTexts) {
  const host = client(t);
  const guest = client(t);
  const created = await host.send('room:create', { key: host.key, name: 'Asha', title: 'Dinner?', mode });
  assert.equal(created.ok, true);
  const joined = await guest.send('room:join', { code: created.code, key: guest.key, name: 'Ben' });
  assert.equal(joined.ok, true);
  for (const text of optionTexts) {
    assert.equal((await host.send('option:add', { text })).ok, true);
  }
  const state = await guest.until((s) => s.options.length === optionTexts.length);
  return { host, guest, code: created.code, ids: state.options.map((o) => o.id) };
}

test('pages and QR codes are served', async (t) => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Settle/);
  assert.equal((await fetch(base + '/healthz')).status, 200);

  const { code } = await roomWith(t, 'ranked', ['Pizza', 'Sushi']);
  const page = await fetch(`${base}/r/${code}`);
  assert.equal(page.status, 200);
  const qr = await fetch(`${base}/qr/${code}`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type'), /svg/);
  assert.equal((await fetch(`${base}/qr/ZZZZZ`)).status, 404);
});

test('ranked choice: full round from options to winner', async (t) => {
  const { host, guest, ids } = await roomWith(t, 'ranked', ['Pizza', 'Sushi', 'Tacos']);
  const [pizza, sushi, tacos] = ids;

  assert.match((await guest.send('phase:start')).error, /host/);
  assert.equal((await host.send('phase:start')).ok, true);
  await guest.until((s) => s.phase === 'vote');

  assert.ok((await guest.send('vote:submit', { ballot: [pizza, sushi] })).error, 'partial ranking is rejected');
  assert.equal((await host.send('vote:submit', { ballot: [sushi, pizza, tacos] })).ok, true);
  const waiting = await guest.until((s) => s.members.some((m) => m.voted));
  assert.equal(waiting.phase, 'vote');
  assert.equal(waiting.myBallot, null, 'other people cannot see your ballot');

  assert.equal((await guest.send('vote:submit', { ballot: [sushi, tacos, pizza] })).ok, true);
  const done = await host.until((s) => s.phase === 'result');
  assert.equal(done.result.final, sushi);
  assert.equal(done.result.tie, null);
});

test('swipe: a tie is settled by the wheel, which only the host can spin', async (t) => {
  const { host, guest, ids } = await roomWith(t, 'swipe', ['Dune', 'Up']);
  const [dune, up] = ids;
  await host.send('phase:start');
  await host.send('vote:submit', { ballot: { [dune]: true, [up]: false } });
  await guest.send('vote:submit', { ballot: { [dune]: false, [up]: true } });

  const tied = await host.until((s) => s.phase === 'result');
  assert.equal(tied.result.final, null);
  assert.deepEqual(tied.result.tie.slice().sort(), ids.slice().sort());

  assert.match((await guest.send('wheel:spin')).error, /host/);
  await host.send('wheel:spin');
  const spun = await guest.until((s) => s.result && s.result.wheel);
  assert.ok(ids.includes(spun.result.final));
  assert.equal(spun.result.final, spun.result.wheel.winnerId);

  // Spinning again changes nothing.
  await host.send('wheel:spin');
  assert.equal(host.state().result.wheel.spinId, spun.result.wheel.spinId);
});

test('veto: limits are enforced and the host can reveal early', async (t) => {
  const { host, guest, ids } = await roomWith(t, 'veto', ['Mon', 'Tue', 'Wed']);
  await host.send('phase:start');
  assert.ok((await host.send('vote:submit', { ballot: [ids[0], ids[1]] })).error, 'only one veto each by default');
  await host.send('vote:submit', { ballot: [ids[0]] });
  await host.send('phase:reveal');
  const done = await guest.until((s) => s.phase === 'result');
  assert.deepEqual(done.result.tie.slice().sort(), [ids[1], ids[2]].sort());
});

test('options: duplicates, ownership and locking', async (t) => {
  const { host, guest, ids } = await roomWith(t, 'ranked', ['Pizza', 'Sushi']);
  assert.match((await guest.send('option:add', { text: 'pizza' })).error, /already/);
  assert.match((await guest.send('option:remove', { id: ids[0] })).error, /only remove/);
  assert.equal((await guest.send('option:add', { text: '  Tacos   al pastor ' })).ok, true);
  const state = await host.until((s) => s.options.length === 3);
  assert.equal(state.options[2].text, 'Tacos al pastor');

  await host.send('phase:start');
  assert.match((await guest.send('option:add', { text: 'Late idea' })).error, /locked/);
});

test('a refresh keeps your seat and your vote; reset starts a new round', async (t) => {
  const { host, guest, code, ids } = await roomWith(t, 'veto', ['A', 'B', 'C']);
  await host.send('phase:start');
  await guest.send('vote:submit', { ballot: [ids[2]] });

  guest.socket.close();
  await host.until((s) => s.members.some((m) => !m.connected));

  const back = client(t);
  back.key = guest.key;
  const peek = await back.send('room:peek', { code, key: back.key });
  assert.equal(peek.member, true);
  const rejoined = await back.send('room:join', { code, key: back.key });
  assert.equal(rejoined.state.members.length, 2);
  assert.deepEqual(rejoined.state.myBallot, [ids[2]]);

  await host.send('phase:reveal');
  await host.send('room:reset', { keepOptions: true });
  const fresh = await back.until((s) => s.phase === 'collect' && s.round === 2);
  assert.equal(fresh.options.length, 3);
  assert.equal(fresh.result, null);
  assert.equal(fresh.myBallot, null);
});

test('the host role moves on when the host leaves', async (t) => {
  const { host, guest } = await roomWith(t, 'ranked', ['A', 'B']);
  const guestId = guest.state().you;
  host.socket.close();
  const state = await guest.until((s) => s.hostId === guestId);
  assert.equal(state.hostId, guestId);
});

test('unknown rooms are reported as gone', async (t) => {
  const stranger = client(t);
  assert.equal((await stranger.send('room:peek', { code: 'NOPE2' })).exists, false);
  assert.equal((await stranger.send('room:join', { code: 'NOPE2', key: stranger.key, name: 'X' })).gone, true);
});

test('one room can decide several things: a new round can carry a new question', async (t) => {
  const { host, guest } = await roomWith(t, 'veto', ['Pizza', 'Sushi']);
  await host.send('phase:start');
  await host.send('vote:submit', { ballot: [] });
  await host.send('phase:reveal');
  await host.send('room:reset', { keepOptions: false, title: 'Where should we go for the trip?' });
  const fresh = await guest.until((s) => s.round === 2);
  assert.equal(fresh.title, 'Where should we go for the trip?');
  assert.equal(fresh.options.length, 0);
  assert.equal(fresh.members.length, 2);
});

test('pick one: any topic, each person selects a single option', async (t) => {
  const { host, guest, ids } = await roomWith(t, 'pick', ['Blue', 'Green', 'Red']);
  await host.send('phase:start');
  assert.ok((await host.send('vote:submit', { ballot: [ids[0]] })).error, 'a list is not a single choice');
  assert.ok((await host.send('vote:submit', { ballot: 'nope' })).error, 'unknown options are rejected');
  await host.send('vote:submit', { ballot: ids[1] });
  await guest.send('vote:submit', { ballot: ids[1] });
  const done = await host.until((s) => s.phase === 'result');
  assert.equal(done.result.final, ids[1]);
  assert.equal(done.result.rows[0].votes, 2);
});

test('the host can rename the topic until voting starts', async (t) => {
  const { host, guest } = await roomWith(t, 'pick', ['A', 'B']);
  assert.match((await guest.send('room:settings', { title: 'Hijacked' })).error, /host/);
  assert.equal((await host.send('room:settings', { title: '  Which laptop should we buy?  ' })).ok, true);
  const renamed = await guest.until((s) => s.title !== 'Dinner?');
  assert.equal(renamed.title, 'Which laptop should we buy?');

  await host.send('phase:start');
  assert.match((await host.send('room:settings', { title: 'Too late' })).error, /locked/);
});
