(() => {
  'use strict';

  // ------------------------------------------------------------ basics

  const app = document.getElementById('app');
  const netBanner = document.getElementById('net');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const MODES = {
    pick: {
      name: 'Pick one',
      blurb: 'Everyone chooses one option. The option with the most votes wins.',
    },
    ranked: {
      name: 'Ranked choice',
      blurb: 'Everyone ranks the options. The one most people are happy with wins.',
    },
    swipe: {
      name: 'Swipe',
      blurb: 'Yes or no on each option. The most yeses wins.',
    },
    veto: {
      name: 'Veto',
      blurb: 'Everyone strikes out what they can’t stand. The least-hated option wins.',
    },
  };

  const TEMPLATES = [
    { label: 'Food', title: 'Where should we eat?' },
    { label: 'Movie', title: 'What should we watch?' },
    { label: 'Trip', title: 'Where should we go?' },
    { label: 'Dates', title: 'When should we meet?' },
    { label: 'Game', title: 'What should we play?' },
    { label: 'Gift', title: 'What gift should we buy?' },
    { label: 'Name', title: 'What should we name it?' },
  ];

  const ICONS = {
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    up: '<path d="M6 14l6-6 6 6"/>',
    down: '<path d="M6 10l6 6 6-6"/>',
    grip: '<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    share: '<path d="M12 15V4M8 8l4-4 4 4M5 13v5a2 2 0 002 2h10a2 2 0 002-2v-5"/>',
    users: '<path d="M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 19v-1a4 4 0 00-3-3.9M15.5 3.2a3.5 3.5 0 010 6.6"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  };

  function icon(name, size = 18) {
    const span = document.createElement('span');
    span.className = 'icon';
    // Static markup from the table above, never user input.
    span.innerHTML =
      `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
      `stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span;
  }

  /** Tiny element builder. All text goes through text nodes, so user input is never parsed as HTML. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === 'class') el.className = value;
        else if (key === 'text') el.textContent = value;
        else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
        else if (value === true) el.setAttribute(key, '');
        else el.setAttribute(key, value);
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  /** Rebuilds an element's children only when `signature` changes, so focus and inputs survive live updates. */
  function sync(el, signature, build) {
    if (el._sig === signature) return;
    el._sig = signature;
    el.replaceChildren(...[].concat(build()).filter(Boolean));
  }

  const store = {
    get(key) {
      try { return localStorage.getItem(key); } catch (e) { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, value); } catch (e) { /* private mode: keep going */ }
    },
  };

  function randomKey() {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  // A private key that identifies this browser, so a refresh keeps your seat and your vote.
  let clientKey = store.get('settle:key');
  if (!clientKey || clientKey.length < 16) {
    clientKey = randomKey();
    store.set('settle:key', clientKey);
  }

  function shuffle(list) {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  function plural(n, one, many) {
    return `${n} ${n === 1 ? one : many || one + 's'}`;
  }

  function toast(message) {
    const box = document.getElementById('toasts');
    const el = h('div', { class: 'toast', text: message });
    box.append(el);
    setTimeout(() => el.remove(), 4200);
  }

  // ------------------------------------------------------------ connection

  const socket = io();

  function send(event, payload) {
    return new Promise((resolve) => {
      socket.timeout(10000).emit(event, payload || {}, (err, res) => {
        if (err) resolve({ error: 'No reply from the server. Check your connection and try again.' });
        else resolve(res || { ok: true });
      });
    });
  }

  let current = null;   // code of the room we are in
  let state = null;     // latest room state from the server
  let everConnected = false;

  socket.on('connect', async () => {
    netBanner.hidden = true;
    if (everConnected && current) {
      // Reconnected: take our seat again.
      const res = await send('room:join', { code: current, key: clientKey });
      if (res.gone) showMissing('This room has ended.');
      else if (res.state) setState(res.state);
    }
    everConnected = true;
  });

  socket.on('disconnect', () => {
    netBanner.hidden = false;
  });

  socket.on('room:state', (next) => {
    if (next && next.code === current) setState(next);
  });

  // ------------------------------------------------------------ routing

  function route() {
    const match = location.pathname.match(/^\/r\/([A-Za-z0-9]{4,8})\/?$/);
    if (match) enterRoom(match[1].toUpperCase());
    else showHome();
  }
  window.addEventListener('popstate', route);

  function resetRoomView() {
    if (current) socket.emit('room:leave');
    if (room && room.dialog) room.dialog.remove();
    current = null;
    state = null;
    room = null;
    document.title = 'Settle — decide together, fast';
  }

  async function enterRoom(code) {
    resetRoomView();
    app.replaceChildren(h('p', { class: 'loading', text: 'Finding the room…' }));
    const res = await send('room:peek', { code, key: clientKey });
    if (res.error) return showMissing(res.error);
    if (!res.exists) return showMissing();
    // Returning members go straight back to their seat.
    if (res.member && (await join(code, '')) !== 'error') return;
    showJoin(code, res);
  }

  /** Resolves to 'ok', 'gone' (room no longer exists) or 'error'. */
  async function join(code, name) {
    const res = await send('room:join', { code, key: clientKey, name });
    if (res.gone) {
      showMissing();
      return 'gone';
    }
    if (res.error || !res.state) {
      toast(res.error || 'Could not join the room.');
      return 'error';
    }
    current = code;
    setState(res.state);
    return 'ok';
  }

  // ------------------------------------------------------------ home

  function modePicker(selected, onPick) {
    const wrap = h('div', { class: 'modes', role: 'radiogroup', 'aria-label': 'Voting style' });
    const blurb = h('p', { class: 'mode-blurb' });
    const draw = () => {
      blurb.textContent = MODES[selected].blurb;
      wrap.replaceChildren(
        ...Object.entries(MODES).map(([key, mode]) =>
          h('button', {
            type: 'button',
            class: 'mode' + (key === selected ? ' is-on' : ''),
            role: 'radio',
            'aria-checked': key === selected ? 'true' : 'false',
            onclick: () => {
              if (selected === key) return;
              selected = key;
              draw();
              onPick(key);
              const on = wrap.querySelector('.is-on');
              if (on) on.focus();
            },
          },
          mode.name)),
      );
    };
    draw();
    return h('div', { class: 'mode-picker' }, wrap, blurb);
  }

  function showHome() {
    resetRoomView();
    let mode = 'pick';

    const title = h('input', {
      id: 'title', type: 'text', maxlength: '80', autocomplete: 'off',
      placeholder: 'Type any topic or question', required: true,
    });
    const name = h('input', {
      id: 'name', type: 'text', maxlength: '24', autocomplete: 'nickname',
      placeholder: 'Your name', value: store.get('settle:name') || '', required: true,
    });
    const submit = h('button', { class: 'btn btn-primary btn-big', type: 'submit' }, 'Create room');

    const form = h('form', {
      class: 'card create',
      onsubmit: async (e) => {
        e.preventDefault();
        const topic = title.value.trim();
        if (!topic) {
          toast('Type what you are deciding first.');
          return title.focus();
        }
        const who = name.value.trim();
        if (!who) return name.focus();
        submit.disabled = true;
        submit.textContent = 'Creating…';
        store.set('settle:name', who);
        const res = await send('room:create', {
          key: clientKey, name: who, mode,
          title: topic,
        });
        if (res.error || !res.state) {
          submit.disabled = false;
          submit.textContent = 'Create room';
          return toast(res.error || 'Could not create the room.');
        }
        history.pushState({}, '', '/r/' + res.code);
        current = res.code;
        setState(res.state);
      },
    },
    h('label', { for: 'title', text: 'What are you deciding? Type any topic.' }),
    title,
    h('div', { class: 'chips' }, TEMPLATES.map((t) =>
      h('button', {
        type: 'button', class: 'chip',
        onclick: () => { title.value = t.title; },
      }, t.label))),
    h('p', { class: 'label', text: 'How should people vote?' }),
    modePicker(mode, (picked) => { mode = picked; }),
    h('label', { for: 'name', text: 'Your name' }),
    name,
    submit);

    const code = h('input', {
      type: 'text', maxlength: '8', autocomplete: 'off', autocapitalize: 'characters',
      placeholder: 'Room code', 'aria-label': 'Room code', class: 'code-input',
    });
    const joinForm = h('form', {
      class: 'join-code',
      onsubmit: (e) => {
        e.preventDefault();
        const value = code.value.trim().toUpperCase();
        if (!/^[A-Z0-9]{4,8}$/.test(value)) return toast('Enter the room code, like K7M2Q.');
        history.pushState({}, '', '/r/' + value);
        route();
      },
    }, code, h('button', { class: 'btn', type: 'submit' }, 'Join'));

    app.replaceChildren(h('div', { class: 'home' },
      h('div', { class: 'home-left' },
        h('section', { class: 'hero' },
          h('p', { class: 'eyebrow', text: 'Group decisions in a minute' }),
          h('h1', null, 'Stop going in circles. ', h('em', { text: 'Settle it.' })),
          h('p', { text: 'Make a room, share the link, and let everyone vote. No sign-up, nothing to install.' })),
        h('ol', { class: 'steps' },
          h('li', null, h('strong', { text: 'Share the link' }), h('span', { text: 'Or let people scan the QR code.' })),
          h('li', null, h('strong', { text: 'Add options' }), h('span', { text: 'Restaurants, movies, dates. Anything.' })),
          h('li', null, h('strong', { text: 'Vote' }), h('span', { text: 'If it’s a tie, a wheel picks.' }))),
        h('section', { class: 'card join-card' },
          h('h2', { text: 'Got a code?' }),
          joinForm)),
      form,
    ));
  }

  // ------------------------------------------------------------ join / missing

  function showJoin(code, info) {
    const name = h('input', {
      id: 'join-name', type: 'text', maxlength: '24', autocomplete: 'nickname',
      placeholder: 'Your name', value: store.get('settle:name') || '', required: true,
    });
    const submit = h('button', { class: 'btn btn-primary btn-big', type: 'submit' }, 'Join the room');
    const people = info.people || [];

    app.replaceChildren(h('form', {
      class: 'card join',
      onsubmit: async (e) => {
        e.preventDefault();
        const who = name.value.trim();
        if (!who) return name.focus();
        store.set('settle:name', who);
        submit.disabled = true;
        if ((await join(code, who)) === 'error') submit.disabled = false;
      },
    },
    h('p', { class: 'eyebrow', text: 'You’re invited to decide' }),
    h('h1', { text: info.title }),
    people.length
      ? h('p', { class: 'muted', text: `Already here: ${people.join(', ')}` })
      : null,
    h('label', { for: 'join-name', text: 'Your name' }),
    name,
    submit));
    name.focus();
  }

  function showMissing(message) {
    resetRoomView();
    app.replaceChildren(h('section', { class: 'card missing' },
      h('h1', { text: 'This room isn’t here' }),
      h('p', { class: 'muted', text: message || 'Rooms close after everyone leaves, or the code may be mistyped.' }),
      h('a', { class: 'btn btn-primary btn-big', href: '/' }, 'Start a new room')));
  }

  // ------------------------------------------------------------ room

  let room = null;                 // DOM handles for the room view
  let local = freshLocal(0);       // per-round UI state that the server doesn't know about

  function freshLocal(round) {
    return { round, editing: false, spinning: null, celebrated: false };
  }

  const me = () => state.members.find((m) => m.id === state.you);
  const isHost = () => state.hostId === state.you;
  const hostName = () => (state.members.find((m) => m.id === state.hostId) || {}).name || 'the host';
  const optionText = (id) => (state.options.find((o) => o.id === id) || {}).text || '';
  const memberName = (id) => (state.members.find((m) => m.id === id) || {}).name || 'someone';
  const inviteUrl = () => `${location.origin}/r/${state.code}`;

  function setState(next) {
    const prev = state;
    if (!prev || prev.code !== next.code || local.round !== next.round) local = freshLocal(next.round);

    // The wheel only spins for people who were watching when the host pressed the button.
    const hadWheel = prev && prev.result && prev.result.wheel;
    const wasTie = prev && prev.code === next.code && prev.result && prev.result.tie;
    if (wasTie && !hadWheel && next.result && next.result.wheel && !reducedMotion) {
      local.spinning = next.result.wheel.spinId;
    }

    state = next;
    document.title = `${state.title} · Settle`;
    renderRoom();
  }

  function renderRoom() {
    if (!room) {
      room = {
        header: h('header', { class: 'room-head' }),
        body: h('div', { class: 'phase' }),
        key: null,
        update: null,
        dialog: null,
      };
      app.replaceChildren(h('div', { class: 'room' }, room.header, room.body));
    }
    renderHeader();

    const key = phaseKey();
    if (key !== room.key) {
      room.key = key;
      room.update = null;
      const built = buildPhase();
      room.body.replaceChildren(...[].concat(built).filter(Boolean));
      window.scrollTo({ top: 0 });
    }
    if (room.update) room.update();
  }

  function wheelStage() {
    const r = state.result;
    if (!r || !r.tie) return 'none';
    if (!r.wheel) return 'tie';
    return local.spinning === r.wheel.spinId ? 'spinning' : 'done';
  }

  function phaseKey() {
    const base = `${state.phase}:${state.round}`;
    if (state.phase === 'vote') {
      const voting = !state.myBallot || local.editing;
      return `${base}:${state.mode}:${voting ? 'ballot' : 'waiting'}`;
    }
    if (state.phase === 'result') return `${base}:${wheelStage()}`;
    return base;
  }

  function buildPhase() {
    if (state.phase === 'collect') return buildCollect();
    if (state.phase === 'vote') {
      return !state.myBallot || local.editing ? buildBallot() : buildWaiting();
    }
    return buildResult();
  }

  // -- header ---------------------------------------------------------

  const AVATAR_COLOURS = ['#d43a25', '#1f8a5b', '#2b6cb0', '#8e44ad', '#b7791f', '#0f8b8d', '#c2417a', '#5a67d8'];

  function avatarColour(id) {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return AVATAR_COLOURS[hash % AVATAR_COLOURS.length];
  }

  function personChip(member) {
    const voted = state.phase === 'vote' && member.voted;
    const notes = [];
    if (member.id === state.you) notes.push('you');
    if (member.id === state.hostId) notes.push('host');
    if (!member.connected) notes.push('away');
    return h('li', { class: 'person' + (member.connected ? '' : ' is-away') },
      h('span', {
        class: 'avatar', style: `background:${avatarColour(member.id)}`, 'aria-hidden': 'true',
        text: (member.name[0] || '?').toUpperCase(),
      }),
      h('span', { class: 'person-name', text: member.name }),
      notes.length ? h('span', { class: 'person-note', text: notes.join(', ') }) : null,
      voted ? h('span', { class: 'person-voted', title: 'Voted' }, icon('check', 14), h('span', { class: 'sr', text: 'voted' })) : null);
  }

  function renderHeader() {
    const sig = JSON.stringify([state.title, state.mode, state.phase, state.members, state.hostId]);
    sync(room.header, sig, () => {
      const steps = ['collect', 'vote', 'result'];
      const labels = { collect: 'Options', vote: 'Vote', result: 'Result' };
      return [
        h('ol', { class: 'progress', 'aria-label': 'Progress' }, steps.map((step) =>
          h('li', {
            class: step === state.phase ? 'is-now' : steps.indexOf(step) < steps.indexOf(state.phase) ? 'is-done' : '',
            'aria-current': step === state.phase ? 'step' : null,
            text: labels[step],
          }))),
        h('div', { class: 'title-row' },
          h('h1', { text: state.title }),
          isHost() && state.phase === 'collect'
            ? h('button', {
              class: 'icon-btn', type: 'button', title: 'Edit topic', 'aria-label': 'Edit topic',
              onclick: openTitleEdit,
            }, icon('edit', 16))
            : null),
        h('div', { class: 'room-meta' },
          h('span', { class: 'tag', text: MODES[state.mode].name }),
          h('button', { class: 'btn btn-small', type: 'button', onclick: openInvite }, icon('users', 16), 'Invite')),
        h('ul', { class: 'people', 'aria-label': 'People in this room' }, state.members.map(personChip)),
      ];
    });
  }

  // -- invite ---------------------------------------------------------

  async function copyLink(button) {
    try {
      await navigator.clipboard.writeText(inviteUrl());
      const label = button.lastChild;
      const old = label.textContent;
      label.textContent = 'Copied';
      setTimeout(() => { label.textContent = old; }, 1600);
    } catch (e) {
      window.prompt('Copy this link:', inviteUrl());
    }
  }

  function sharePanel() {
    const copy = h('button', { class: 'btn', type: 'button', onclick: () => copyLink(copy) }, icon('link', 16), 'Copy link');
    const share = navigator.share
      ? h('button', {
        class: 'btn', type: 'button',
        onclick: () => navigator.share({ title: state.title, text: `Help decide: ${state.title}`, url: inviteUrl() }).catch(() => {}),
      }, icon('share', 16), 'Share')
      : null;
    return h('div', { class: 'share' },
      h('img', { class: 'qr', src: `/qr/${state.code}`, width: '132', height: '132', alt: 'QR code that opens this room' }),
      h('div', { class: 'share-text' },
        h('p', { class: 'share-code' }, 'Room code ', h('strong', { text: state.code })),
        h('p', { class: 'share-url', text: inviteUrl().replace(/^https?:\/\//, '') }),
        h('div', { class: 'row' }, copy, share)));
  }

  function roomDialog() {
    if (!room.dialog) {
      room.dialog = h('dialog', { class: 'dialog' });
      room.dialog.addEventListener('click', (e) => {
        if (e.target === room.dialog) room.dialog.close();
      });
      document.body.append(room.dialog);
    }
    return room.dialog;
  }

  function openTitleEdit() {
    const dialog = roomDialog();
    const input = h('input', {
      id: 'edit-title', type: 'text', maxlength: '80', autocomplete: 'off',
      value: state.title, required: true,
    });
    dialog.replaceChildren(h('form', {
      class: 'dialog-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const title = input.value.trim();
        if (!title) return input.focus();
        const res = await send('room:settings', { title });
        if (res.error) return toast(res.error);
        dialog.close();
      },
    },
    h('h2', { text: 'Edit topic' }),
    h('label', { for: 'edit-title', text: 'What are you deciding?' }),
    input,
    h('div', { class: 'row' },
      h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
      h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel'))));
    if (dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    input.select();
  }

  function openInvite() {
    if (!room.dialog) {
      room.dialog = h('dialog', { class: 'dialog' });
      room.dialog.addEventListener('click', (e) => {
        if (e.target === room.dialog) room.dialog.close();
      });
      document.body.append(room.dialog);
    }
    room.dialog.replaceChildren(
      h('h2', { text: 'Invite people' }),
      h('p', { class: 'muted', text: 'Anyone with the link can join.' }),
      sharePanel(),
      h('button', { class: 'btn btn-wide', type: 'button', onclick: () => room.dialog.close() }, 'Done'));
    if (room.dialog.showModal) room.dialog.showModal();
    else room.dialog.setAttribute('open', '');
  }

  // -- phase 1: collect options --------------------------------------

  function buildCollect() {
    const count = h('span', { class: 'count' });
    const list = h('ul', { class: 'options' });
    const input = h('input', {
      type: 'text', maxlength: '60', autocomplete: 'off', enterkeyhint: 'done',
      placeholder: 'Add an option…', 'aria-label': 'Add an option',
    });
    const controls = h('section', { class: 'card controls' });

    const form = h('form', {
      class: 'add',
      onsubmit: async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        input.focus();
        const res = await send('option:add', { text });
        if (res.error) {
          toast(res.error);
          if (!input.value) input.value = text;
        }
      },
    }, input, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add'));

    room.update = () => {
      const host = isHost();
      count.textContent = state.options.length ? String(state.options.length) : '';

      sync(list, JSON.stringify([state.options, host, state.members.map((m) => m.name)]), () =>
        state.options.length
          ? state.options.map((option) => {
            const mine = option.by === state.you;
            return h('li', { class: 'option' },
              h('div', { class: 'option-text' },
                h('strong', { text: option.text }),
                h('span', { class: 'muted', text: mine ? 'Added by you' : `Added by ${memberName(option.by)}` })),
              host || mine
                ? h('button', {
                  class: 'icon-btn', type: 'button', 'aria-label': `Remove ${option.text}`,
                  onclick: async () => {
                    const res = await send('option:remove', { id: option.id });
                    if (res.error) toast(res.error);
                  },
                }, icon('x', 16))
                : null);
          })
          : h('li', { class: 'empty', text: 'Nothing yet. Add the first option below.' }));

      // Rebuilding the controls drops keyboard focus, so note where it was and put it back.
      const focused = controls.contains(document.activeElement) ? document.activeElement : null;
      const refocus = focused && (focused.classList.contains('mode') ? '.mode.is-on' : focused.closest('.seg') ? '.seg .is-on' : null);
      setTimeout(() => {
        if (refocus && !controls.contains(document.activeElement)) {
          const target = controls.querySelector(refocus);
          if (target) target.focus();
        }
      });

      sync(controls, JSON.stringify([host, state.mode, state.vetoesPer, state.options.length, hostName()]), () => {
        if (!host) {
          return [
            h('h2', { text: MODES[state.mode].name }),
            h('p', { class: 'muted', text: MODES[state.mode].blurb }),
            h('p', { class: 'waiting-note', text: `${hostName()} will start the vote when the list is ready.` }),
          ];
        }
        const enough = state.options.length >= 2;
        const start = h('button', {
          class: 'btn btn-primary btn-big', type: 'button', disabled: !enough,
          onclick: async () => {
            const res = await send('phase:start');
            if (res.error) toast(res.error);
          },
        }, 'Start voting');
        return [
          h('h2', { text: 'How should people vote?' }),
          modePicker(state.mode, async (mode) => {
            const res = await send('room:settings', { mode });
            if (res.error) toast(res.error);
          }),
          state.mode === 'veto'
            ? h('div', { class: 'stepper' },
              h('span', { text: 'Vetoes per person' }),
              h('div', { class: 'seg' }, [1, 2, 3].map((n) =>
                h('button', {
                  type: 'button', class: n === state.vetoesPer ? 'is-on' : '',
                  'aria-pressed': n === state.vetoesPer ? 'true' : 'false',
                  onclick: () => send('room:settings', { vetoesPer: n }),
                }, String(n)))))
            : null,
          start,
          enough ? null : h('p', { class: 'muted center', text: 'Add at least two options to start.' }),
        ];
      });
    };

    return [
      h('div', { class: 'main' },
        h('section', { class: 'card' },
          h('h2', null, 'Options ', count),
          list,
          form)),
      h('div', { class: 'side' },
        h('section', { class: 'card invite-card' },
          h('h2', { text: 'Invite people' }),
          sharePanel()),
        controls),
    ];
  }

  // -- phase 2: vote --------------------------------------------------

  async function submitBallot(ballot, button) {
    button.disabled = true;
    const res = await send('vote:submit', { ballot });
    if (res.error) {
      button.disabled = false;
      return toast(res.error);
    }
    local.editing = false;
    if (state) renderRoom();
  }

  /** Bar shown to the host under the ballot and the waiting screen. */
  function hostBar() {
    const bar = h('section', { class: 'card grow' });
    const update = () => {
      const voted = state.members.filter((m) => m.voted).length;
      const present = state.members.filter((m) => m.connected).length;
      sync(bar, JSON.stringify([isHost(), state.members]), () => [
        h('h2', { text: 'Votes' }),
        h('p', { class: 'tally' }, String(voted), h('small', { text: `of ${present} voted` })),
        h('ul', { class: 'waitlist' }, state.members.filter((m) => m.connected || m.voted).map((m) =>
          h('li', { class: m.voted ? 'is-done' : '' },
            h('span', { text: m.name }),
            h('span', { class: 'muted', text: m.voted ? 'Voted' : 'Choosing…' })))),
        isHost()
          ? h('button', {
            class: 'btn', type: 'button', disabled: voted === 0,
            onclick: async () => {
              const res = await send('phase:reveal');
              if (res.error) toast(res.error);
            },
          }, 'Show results now')
          : null,
      ]);
    };
    return { bar, update };
  }

  function buildBallot() {
    const { bar, update } = hostBar();
    room.update = update;
    const builders = { pick: buildPick, ranked: buildRanked, swipe: buildSwipe, veto: buildVeto };
    return [h('div', { class: 'main' }, builders[state.mode]()), h('div', { class: 'side' }, bar)];
  }

  // Ranked: drag, or use the arrows, to put the options in order.
  function buildRanked() {
    const ids = state.options.map((o) => o.id);
    let order = Array.isArray(state.myBallot) && state.myBallot.length === ids.length
      ? state.myBallot.slice()
      : shuffle(ids);

    const list = h('ol', { class: 'rank' });
    const submit = h('button', {
      class: 'btn btn-primary btn-big', type: 'button',
      onclick: () => submitBallot(order, submit),
    }, 'Submit my ranking');

    function move(id, delta) {
      const from = order.indexOf(id);
      const to = from + delta;
      if (to < 0 || to >= order.length) return;
      order.splice(to, 0, order.splice(from, 1)[0]);
      draw();
      const btn = list.querySelector(`[data-id="${id}"] .${delta < 0 ? 'up' : 'down'}`);
      if (btn && !btn.disabled) btn.focus();
      else {
        const other = list.querySelector(`[data-id="${id}"] .${delta < 0 ? 'down' : 'up'}`);
        if (other) other.focus();
      }
    }

    function draw() {
      list.replaceChildren(...order.map((id, i) =>
        h('li', { class: 'rank-item', 'data-id': id },
          h('span', { class: 'rank-num', text: String(i + 1) }),
          h('strong', { class: 'rank-text', text: optionText(id) }),
          h('button', {
            class: 'icon-btn up', type: 'button', disabled: i === 0,
            'aria-label': `Move ${optionText(id)} up`, onclick: () => move(id, -1),
          }, icon('up')),
          h('button', {
            class: 'icon-btn down', type: 'button', disabled: i === order.length - 1,
            'aria-label': `Move ${optionText(id)} down`, onclick: () => move(id, 1),
          }, icon('down')),
          h('span', { class: 'grip', 'aria-hidden': 'true' }, icon('grip', 20)))));
    }
    draw();

    // Drag to reorder. The dragged row itself is never re-inserted (its
    // neighbours hop over it instead), so the pointer capture is never lost.
    let dragging = null;
    list.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.grip');
      if (!grip || e.button > 0) return;
      dragging = grip.closest('li');
      dragging.classList.add('is-dragging');
      grip.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    list.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const others = [...list.children].filter((li) => li !== dragging);
      let target = others.findIndex((li) => {
        const box = li.getBoundingClientRect();
        return e.clientY < box.top + box.height / 2;
      });
      if (target === -1) target = others.length;
      let index = [...list.children].indexOf(dragging);
      while (index > target) { dragging.after(dragging.previousElementSibling); index--; }
      while (index < target) { dragging.before(dragging.nextElementSibling); index++; }
      [...list.children].forEach((li, i) => { li.querySelector('.rank-num').textContent = String(i + 1); });
    });
    const drop = () => {
      if (!dragging) return;
      dragging.classList.remove('is-dragging');
      dragging = null;
      order = [...list.children].map((li) => li.dataset.id);
      draw();
    };
    list.addEventListener('pointerup', drop);
    list.addEventListener('pointercancel', drop);

    return h('section', { class: 'card' },
      h('h2', { text: 'Rank the options' }),
      h('p', { class: 'muted', text: 'Put your favourite at the top. Drag the handle or use the arrows.' }),
      list,
      submit);
  }

  // Swipe: one card at a time, then a review list before submitting.
  function buildSwipe() {
    const options = shuffle(state.options);
    const previous = state.myBallot && !Array.isArray(state.myBallot) ? state.myBallot : null;
    const draft = previous ? { ...previous } : {};
    let index = previous ? options.length : 0;
    let busy = false;

    const wrap = h('section', { class: 'card swipe' });

    function decide(yes) {
      if (busy || index >= options.length) return;
      busy = true;
      draft[options[index].id] = yes;
      const card = wrap.querySelector('.swipe-card');
      const next = () => {
        index += 1;
        busy = false;
        draw();
      };
      if (card && !reducedMotion) {
        card.style.transition = 'transform .18s ease-in, opacity .18s ease-in';
        card.style.transform = `translateX(${yes ? 120 : -120}%) rotate(${yes ? 16 : -16}deg)`;
        card.style.opacity = '0';
        setTimeout(next, 180);
      } else {
        next();
      }
    }

    function drawCard() {
      const option = options[index];
      const card = h('div', {
        class: 'swipe-card', tabindex: '0', role: 'group',
        'aria-label': `${option.text}. Option ${index + 1} of ${options.length}. Press right arrow for yes, left arrow for no.`,
      },
      h('span', { class: 'stamp stamp-yes', 'aria-hidden': 'true', text: 'Yes' }),
      h('span', { class: 'stamp stamp-no', 'aria-hidden': 'true', text: 'No' }),
      h('strong', { text: option.text }));

      let startX = 0;
      let dx = 0;
      let active = false;
      card.addEventListener('pointerdown', (e) => {
        if (e.button > 0 || busy) return;
        active = true;
        startX = e.clientX;
        dx = 0;
        card.setPointerCapture(e.pointerId);
        card.style.transition = 'none';
      });
      card.addEventListener('pointermove', (e) => {
        if (!active) return;
        dx = e.clientX - startX;
        card.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
        card.dataset.lean = dx > 40 ? 'yes' : dx < -40 ? 'no' : '';
      });
      const release = () => {
        if (!active) return;
        active = false;
        card.style.transition = '';
        if (Math.abs(dx) > 90) return decide(dx > 0);
        card.style.transform = '';
        card.dataset.lean = '';
      };
      card.addEventListener('pointerup', release);
      card.addEventListener('pointercancel', release);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight') decide(true);
        if (e.key === 'ArrowLeft') decide(false);
      });

      wrap.replaceChildren(
        h('h2', { text: 'Yes or no?' }),
        h('p', { class: 'muted', text: `Option ${index + 1} of ${options.length}. Swipe right for yes, left for no.` }),
        h('div', { class: 'deck' }, card),
        h('div', { class: 'swipe-actions' },
          h('button', { class: 'round no', type: 'button', onclick: () => decide(false) }, icon('x', 26), h('span', { text: 'No' })),
          h('button', { class: 'round yes', type: 'button', onclick: () => decide(true) }, icon('check', 26), h('span', { text: 'Yes' }))));
    }

    function drawReview() {
      const submit = h('button', {
        class: 'btn btn-primary btn-big', type: 'button',
        onclick: () => submitBallot(draft, submit),
      }, 'Submit my votes');
      const list = h('ul', { class: 'review' });
      const drawList = () => {
        list.replaceChildren(...state.options.map((option) =>
          h('li', null,
            h('strong', { text: option.text }),
            h('div', { class: 'seg' },
              h('button', {
                type: 'button', class: draft[option.id] === false ? 'is-on no' : '',
                'aria-pressed': draft[option.id] === false ? 'true' : 'false',
                'aria-label': `No to ${option.text}`,
                onclick: () => { draft[option.id] = false; drawList(); },
              }, 'No'),
              h('button', {
                type: 'button', class: draft[option.id] === true ? 'is-on yes' : '',
                'aria-pressed': draft[option.id] === true ? 'true' : 'false',
                'aria-label': `Yes to ${option.text}`,
                onclick: () => { draft[option.id] = true; drawList(); },
              }, 'Yes')))));
      };
      drawList();
      wrap.replaceChildren(
        h('h2', { text: 'Check your answers' }),
        h('p', { class: 'muted', text: 'Change anything you like, then submit.' }),
        list,
        submit);
    }

    function draw() {
      if (index < options.length) {
        drawCard();
        if (index > 0) wrap.querySelector('.swipe-card').focus({ preventScroll: true });
      } else {
        drawReview();
      }
    }
    draw();
    return wrap;
  }

  // Pick one: select a single option.
  function buildPick() {
    let picked = typeof state.myBallot === 'string' ? state.myBallot : null;
    const list = h('ul', { class: 'pick', role: 'radiogroup', 'aria-label': 'Options' });
    const submit = h('button', {
      class: 'btn btn-primary btn-big', type: 'button',
      onclick: () => submitBallot(picked, submit),
    }, 'Submit my choice');

    function draw() {
      submit.disabled = !picked;
      list.replaceChildren(...state.options.map((option, i) => {
        const on = picked === option.id;
        return h('li', null, h('button', {
          type: 'button', class: 'pick-item' + (on ? ' is-on' : ''),
          role: 'radio', 'aria-checked': on ? 'true' : 'false',
          onclick: () => {
            picked = option.id;
            draw();
            const again = list.querySelectorAll('.pick-item')[i];
            if (again) again.focus();
          },
        },
        h('span', { class: 'pick-dot', 'aria-hidden': 'true' }),
        h('strong', { text: option.text })));
      }));
    }
    draw();

    return h('section', { class: 'card' },
      h('h2', { text: 'Choose your option' }),
      h('p', { class: 'muted', text: 'Select the one you want, then submit.' }),
      list,
      submit);
  }

  // Veto: strike out up to N options.
  function buildVeto() {
    const allowed = Math.max(0, Math.min(state.vetoesPer, state.options.length - 1));
    const picked = new Set(Array.isArray(state.myBallot) ? state.myBallot : []);
    const list = h('ul', { class: 'veto' });
    const counter = h('p', { class: 'muted' });
    const submit = h('button', {
      class: 'btn btn-primary btn-big', type: 'button',
      onclick: () => submitBallot([...picked], submit),
    });

    function draw() {
      counter.textContent = `${picked.size} of ${plural(allowed, 'veto', 'vetoes')} used. You don’t have to use them.`;
      submit.textContent = picked.size ? 'Submit my vetoes' : 'Submit with no veto';
      list.replaceChildren(...state.options.map((option) => {
        const on = picked.has(option.id);
        return h('li', null, h('button', {
          type: 'button', class: 'veto-item' + (on ? ' is-on' : ''),
          'aria-pressed': on ? 'true' : 'false',
          onclick: () => {
            if (on) picked.delete(option.id);
            else if (picked.size >= allowed) return toast(`You only get ${plural(allowed, 'veto', 'vetoes')}.`);
            else picked.add(option.id);
            draw();
            const again = list.querySelectorAll('.veto-item')[state.options.indexOf(option)];
            if (again) again.focus();
          },
        },
        h('strong', { text: option.text }),
        h('span', { class: 'veto-mark' }, icon('ban', 18), on ? 'Vetoed' : 'Veto')));
      }));
    }
    draw();

    return h('section', { class: 'card' },
      h('h2', { text: 'Strike out what you can’t stand' }),
      counter,
      list,
      submit);
  }

  function buildWaiting() {
    const { bar, update } = hostBar();
    room.update = update;
    return [
      h('div', { class: 'main' },
        h('section', { class: 'card center' },
          h('div', { class: 'big-check' }, icon('check', 34)),
          h('h2', { text: 'Your vote is in' }),
          h('p', { class: 'muted', text: 'Results appear as soon as everyone has voted.' }),
          h('button', {
            class: 'btn', type: 'button',
            onclick: () => { local.editing = true; renderRoom(); },
          }, 'Change my vote'))),
      h('div', { class: 'side' }, bar),
    ];
  }

  // -- phase 3: result ------------------------------------------------

  const WHEEL_COLOURS = ['#d43a25', '#1f8a5b', '#2b6cb0', '#8e44ad', '#b7791f', '#0f8b8d', '#c2417a', '#5a67d8'];

  function drawWheel(canvas, labels, rotation) {
    const size = canvas.clientWidth || 300;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(size * dpr)) {
      canvas.width = canvas.height = Math.round(size * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const c = size / 2;
    const r = c - 6;
    const slice = (Math.PI * 2) / labels.length;

    labels.forEach((label, i) => {
      const from = rotation + i * slice;
      // Avoid the last slice matching the first one's colour.
      const wraps = i === labels.length - 1 && i > 0 && i % WHEEL_COLOURS.length === 0;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, r, from, from + slice);
      ctx.closePath();
      ctx.fillStyle = WHEEL_COLOURS[wraps ? 1 : i % WHEEL_COLOURS.length];
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(from + slice / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.font = `600 ${labels.length > 8 ? 11 : 14}px system-ui, sans-serif`;
      const max = labels.length > 8 ? 14 : 18;
      ctx.fillText(label.length > max ? label.slice(0, max - 1) + '…' : label, r - 12, 0);
      ctx.restore();
    });

    ctx.beginPath();
    ctx.arc(c, c, 16, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  function spinWheel(canvas, labels, winnerIndex, offset, done) {
    const slice = (Math.PI * 2) / labels.length;
    // The pointer sits at the top (-90deg). Land the winner's slice under it after 7 full turns.
    const target = -Math.PI / 2 - (winnerIndex + 0.5 + offset) * slice + Math.PI * 2 * 7;
    const duration = 5200;
    const started = performance.now();
    function frame(now) {
      const t = Math.min(1, (now - started) / duration);
      const eased = 1 - Math.pow(1 - t, 4);
      // Start from the resting position (-90deg) so the wheel doesn't jump.
      drawWheel(canvas, labels, -Math.PI / 2 + (target + Math.PI / 2) * eased);
      if (t < 1) requestAnimationFrame(frame);
      else setTimeout(done, 500);
    }
    requestAnimationFrame(frame);
  }

  function confetti() {
    if (reducedMotion) return;
    const canvas = document.getElementById('confetti');
    const ctx = canvas.getContext('2d');
    const w = canvas.width = window.innerWidth;
    const hgt = canvas.height = window.innerHeight;
    const bits = Array.from({ length: 130 }, () => ({
      x: w / 2 + (Math.random() - 0.5) * w * 0.3,
      y: hgt * 0.3,
      vx: (Math.random() - 0.5) * 14,
      vy: -Math.random() * 13 - 3,
      size: 5 + Math.random() * 6,
      spin: Math.random() * Math.PI,
      colour: WHEEL_COLOURS[Math.floor(Math.random() * WHEEL_COLOURS.length)],
    }));
    const started = performance.now();
    function frame(now) {
      const age = now - started;
      ctx.clearRect(0, 0, w, hgt);
      if (age > 2800) return;
      ctx.globalAlpha = Math.max(0, 1 - age / 2800);
      for (const bit of bits) {
        bit.vy += 0.35;
        bit.vx *= 0.99;
        bit.x += bit.vx;
        bit.y += bit.vy;
        bit.spin += 0.2;
        ctx.save();
        ctx.translate(bit.x, bit.y);
        ctx.rotate(bit.spin);
        ctx.fillStyle = bit.colour;
        ctx.fillRect(-bit.size / 2, -bit.size / 4, bit.size, bit.size / 2);
        ctx.restore();
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function wheelCard(stage) {
    const result = state.result;
    const candidates = result.tie;
    const labels = candidates.map(optionText);
    const canvas = h('canvas', { class: 'wheel', role: 'img', 'aria-label': `Wheel with ${labels.join(', ')}` });
    const action = h('div', { class: 'wheel-action' });

    // Draw once the canvas has a size on screen.
    requestAnimationFrame(() => {
      if (stage === 'spinning') {
        const wheel = result.wheel;
        spinWheel(canvas, labels, candidates.indexOf(wheel.winnerId), wheel.offset, () => {
          if (local.spinning !== wheel.spinId) return;
          local.spinning = null;
          if (state) renderRoom();
        });
      } else {
        drawWheel(canvas, labels, -Math.PI / 2);
      }
    });

    if (stage === 'tie') {
      room.update = () => {
        sync(action, JSON.stringify([isHost(), hostName()]), () =>
          isHost()
            ? h('button', {
              class: 'btn btn-primary btn-big', type: 'button',
              onclick: async (e) => {
                e.currentTarget.disabled = true;
                const res = await send('wheel:spin');
                if (res.error) toast(res.error);
              },
            }, 'Spin the wheel')
            : h('p', { class: 'waiting-note', text: `Waiting for ${hostName()} to spin the wheel.` }));
      };
    } else {
      action.append(h('p', { class: 'waiting-note', text: 'Spinning…' }));
    }

    return h('section', { class: 'card center' },
      h('p', { class: 'eyebrow', text: 'It’s a tie' }),
      h('h2', { text: `${labels.length} options are level. The wheel decides.` }),
      h('div', { class: 'wheel-wrap' }, h('span', { class: 'pointer', 'aria-hidden': 'true' }), canvas),
      action);
  }

  function winnerCard() {
    const result = state.result;
    const byWheel = Boolean(result.wheel);
    if (!local.celebrated) {
      local.celebrated = true;
      confetti();
    }
    return h('section', { class: 'card winner' },
      h('p', { class: 'eyebrow', text: 'The group picked' }),
      h('h2', { text: optionText(result.final) }),
      h('p', {
        text: byWheel
          ? `It was a ${result.tie.length}-way tie, so the wheel chose.`
          : `Decided by ${plural(result.ballots, 'vote')}.`,
      }));
  }

  function breakdown() {
    const result = state.result;
    const total = Math.max(1, result.ballots);
    const rows = result.rows.map((row) => {
      let share = 0;
      let label = '';
      if (result.mode === 'pick') {
        share = row.votes / total;
        label = plural(row.votes, 'vote');
      } else if (result.mode === 'swipe') {
        share = row.yes / total;
        label = `${row.yes} of ${total} said yes`;
      } else if (result.mode === 'veto') {
        share = row.vetoes / total;
        label = row.vetoes ? plural(row.vetoes, 'veto', 'vetoes') : 'No vetoes';
      } else {
        share = row.first / total;
        label = `${plural(row.first, 'first choice')}` + (row.out ? ` · out in round ${row.out}` : '');
      }
      const isWinner = row.id === result.final;
      return h('li', { class: 'bar-row' + (isWinner ? ' is-winner' : '') },
        h('div', { class: 'bar-head' },
          h('strong', { text: optionText(row.id) }),
          h('span', { class: 'muted', text: label })),
        h('div', { class: 'bar' + (result.mode === 'veto' ? ' bar-bad' : '') },
          h('span', { style: `width:${Math.round(share * 100)}%` })));
    });

    const parts = [h('h2', { text: 'How the vote went' }), h('ul', { class: 'bars' }, rows)];

    if (result.mode === 'ranked' && result.rounds.length > 1) {
      parts.push(h('details', { class: 'rounds' },
        h('summary', { text: `See all ${result.rounds.length} rounds` }),
        h('p', { class: 'muted', text: 'Each round, the option with the fewest votes drops out and its votes move to those voters’ next choice.' }),
        result.rounds.map((round, i) =>
          h('div', { class: 'round-block' },
            h('h3', { text: `Round ${i + 1}` }),
            h('ul', null, Object.entries(round.counts)
              .sort((a, b) => b[1] - a[1])
              .map(([id, votes]) =>
                h('li', { class: round.eliminated.includes(id) ? 'is-out' : '' },
                  h('span', { text: optionText(id) }),
                  h('span', { class: 'muted', text: round.eliminated.includes(id) ? `${votes} · out` : String(votes) }))))))));
    }
    return h('section', { class: 'card grow' }, parts);
  }

  function buildResult() {
    const stage = wheelStage();
    const actions = h('section', { class: 'card actions' });
    const waitingOnWheel = stage === 'tie' || stage === 'spinning';
    const top = waitingOnWheel ? wheelCard(stage) : winnerCard();
    const wheelUpdate = room.update;

    room.update = () => {
      if (wheelUpdate) wheelUpdate();
      sync(actions, JSON.stringify([isHost(), hostName()]), () => {
        if (!isHost()) {
          return [
            h('p', { class: 'muted', text: `${hostName()} can start another round.` }),
            h('a', { class: 'btn', href: '/' }, 'Make your own room'),
          ];
        }
        const reset = async (payload) => {
          const res = await send('room:reset', payload);
          if (res.error) toast(res.error);
        };
        // The same room can decide many things: type the next question and start a new round.
        const next = h('input', {
          id: 'next-title', type: 'text', maxlength: '80', autocomplete: 'off',
          placeholder: 'e.g. Where should we go for the trip?',
        });
        return [
          h('form', {
            class: 'next-round',
            onsubmit: (e) => {
              e.preventDefault();
              reset({ keepOptions: false, title: next.value.trim() });
            },
          },
          h('label', { for: 'next-title', text: 'Decide something else in this room' }),
          next,
          // While the wheel is waiting, "Spin the wheel" is the one main button.
          h('button', { class: waitingOnWheel ? 'btn' : 'btn btn-primary', type: 'submit' }, 'Start a new decision')),
          h('button', { class: 'btn', type: 'button', onclick: () => reset({ keepOptions: true }) }, 'Vote again on these options'),
        ];
      });
    };

    return [
      h('div', { class: 'main' }, top),
      stage === 'spinning' ? null : h('div', { class: 'side' }, breakdown(), actions),
    ];
  }

  // ------------------------------------------------------------ start

  route();
})();
