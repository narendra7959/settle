'use strict';

/**
 * Vote counting for the three voting styles.
 *
 * Every function takes the room's options ([{ id, text }]) and a list of
 * already-validated ballots, and returns:
 *   { mode, ballots, winners: [optionId, ...], rows: [...], rounds? }
 * More than one winner means a tie, which the room settles with the wheel.
 */

// Swipe: each ballot is { optionId: true | false }. Most yeses wins.
function tallySwipe(options, ballots) {
  const rows = options.map((o) => ({
    id: o.id,
    yes: ballots.reduce((n, b) => n + (b[o.id] === true ? 1 : 0), 0),
  }));
  rows.sort((a, b) => b.yes - a.yes);
  const best = rows.length ? rows[0].yes : 0;
  return {
    mode: 'swipe',
    ballots: ballots.length,
    winners: rows.filter((r) => r.yes === best).map((r) => r.id),
    rows,
  };
}

// Pick one: each ballot is a single option id. Most votes wins.
function tallyPick(options, ballots) {
  const rows = options.map((o) => ({
    id: o.id,
    votes: ballots.reduce((n, b) => n + (b === o.id ? 1 : 0), 0),
  }));
  rows.sort((a, b) => b.votes - a.votes);
  const best = rows.length ? rows[0].votes : 0;
  return {
    mode: 'pick',
    ballots: ballots.length,
    winners: rows.filter((r) => r.votes === best).map((r) => r.id),
    rows,
  };
}

// Veto: each ballot is a list of option ids the voter strikes out.
// The option with the fewest vetoes wins.
function tallyVeto(options, ballots) {
  const rows = options.map((o) => ({
    id: o.id,
    vetoes: ballots.reduce((n, b) => n + (b.includes(o.id) ? 1 : 0), 0),
  }));
  rows.sort((a, b) => a.vetoes - b.vetoes);
  const best = rows.length ? rows[0].vetoes : 0;
  return {
    mode: 'veto',
    ballots: ballots.length,
    winners: rows.filter((r) => r.vetoes === best).map((r) => r.id),
    rows,
  };
}

// Ranked choice (instant runoff): each ballot is every option id, best first.
// Each round counts every ballot for its highest-ranked option still in the
// race. An option with more than half the votes wins; otherwise the option
// with the fewest votes is eliminated and the count repeats.
// Ties for last place are broken by Borda score (points for overall rank).
function tallyRanked(options, ballots) {
  const ids = options.map((o) => o.id);
  const n = ids.length;

  const borda = {};
  ids.forEach((id) => { borda[id] = 0; });
  for (const ballot of ballots) {
    ballot.forEach((id, i) => {
      if (id in borda) borda[id] += n - i;
    });
  }

  const remaining = new Set(ids);
  const rounds = [];
  const outRound = {};
  const eliminatedOrder = [];
  let winners = [];
  let lastCounts = {};

  while (remaining.size > 0) {
    const counts = {};
    remaining.forEach((id) => { counts[id] = 0; });
    let active = 0;
    for (const ballot of ballots) {
      const top = ballot.find((id) => remaining.has(id));
      if (top !== undefined) {
        counts[top] += 1;
        active += 1;
      }
    }
    lastCounts = counts;
    const round = { counts: { ...counts }, eliminated: [] };
    rounds.push(round);

    const left = [...remaining];
    const max = Math.max(...left.map((id) => counts[id]));
    const min = Math.min(...left.map((id) => counts[id]));
    const leaders = left.filter((id) => counts[id] === max);

    if (max * 2 > active || left.length === 1) {
      winners = leaders;
      break;
    }
    if (max === min) {
      // Everyone left is level: prefer the best overall rank, else it's a tie.
      const topBorda = Math.max(...left.map((id) => borda[id]));
      winners = left.filter((id) => borda[id] === topBorda);
      break;
    }

    let losers = left.filter((id) => counts[id] === min);
    if (losers.length > 1) {
      const worst = Math.min(...losers.map((id) => borda[id]));
      losers = losers.filter((id) => borda[id] === worst);
    }
    losers.forEach((id) => {
      remaining.delete(id);
      outRound[id] = rounds.length;
      eliminatedOrder.push(id);
    });
    round.eliminated = losers;
  }

  const firstCounts = rounds.length ? rounds[0].counts : {};
  const survivors = [...remaining].sort((a, b) => {
    const aw = winners.includes(a) ? 1 : 0;
    const bw = winners.includes(b) ? 1 : 0;
    return bw - aw || lastCounts[b] - lastCounts[a] || borda[b] - borda[a];
  });
  const order = survivors.concat(eliminatedOrder.reverse());

  return {
    mode: 'ranked',
    ballots: ballots.length,
    winners,
    rows: order.map((id) => ({
      id,
      first: firstCounts[id] || 0,
      final: remaining.has(id) ? lastCounts[id] : 0,
      out: outRound[id] || null,
    })),
    rounds,
  };
}

function tally(mode, options, ballots) {
  if (mode === 'pick') return tallyPick(options, ballots);
  if (mode === 'swipe') return tallySwipe(options, ballots);
  if (mode === 'veto') return tallyVeto(options, ballots);
  return tallyRanked(options, ballots);
}

module.exports = { tally, tallyPick, tallyRanked, tallySwipe, tallyVeto };
