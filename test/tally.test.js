'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { tally } = require('../lib/tally');

const options = ['a', 'b', 'c'].map((id) => ({ id, text: id.toUpperCase() }));

test('swipe: most yeses wins', () => {
  const result = tally('swipe', options, [
    { a: true, b: true, c: false },
    { a: false, b: true, c: false },
    { a: true, b: true, c: true },
  ]);
  assert.deepEqual(result.winners, ['b']);
  assert.deepEqual(result.rows.map((r) => [r.id, r.yes]), [['b', 3], ['a', 2], ['c', 1]]);
});

test('swipe: equal yeses is a tie', () => {
  const result = tally('swipe', options, [{ a: true, b: true, c: false }]);
  assert.deepEqual(result.winners.sort(), ['a', 'b']);
});

test('veto: fewest vetoes wins', () => {
  const result = tally('veto', options, [['a'], ['a'], ['c'], []]);
  assert.deepEqual(result.winners, ['b']);
  assert.equal(result.rows[result.rows.length - 1].id, 'a');
});

test('veto: untouched options tie', () => {
  const result = tally('veto', options, [['a']]);
  assert.deepEqual(result.winners.sort(), ['b', 'c']);
});

test('ranked: outright majority wins in round one', () => {
  const result = tally('ranked', options, [
    ['a', 'b', 'c'],
    ['a', 'c', 'b'],
    ['b', 'a', 'c'],
  ]);
  assert.deepEqual(result.winners, ['a']);
  assert.equal(result.rounds.length, 1);
});

test('ranked: votes transfer when the last-place option drops out', () => {
  // Round 1: a=2, b=2, c=1. c drops out and its vote moves to b, so b wins 3-2.
  const result = tally('ranked', options, [
    ['a', 'b', 'c'],
    ['a', 'b', 'c'],
    ['b', 'a', 'c'],
    ['b', 'a', 'c'],
    ['c', 'b', 'a'],
  ]);
  assert.deepEqual(result.winners, ['b']);
  assert.equal(result.rounds.length, 2);
  assert.deepEqual(result.rounds[0].eliminated, ['c']);
  assert.deepEqual(result.rows.map((r) => r.id), ['b', 'a', 'c']);
  assert.equal(result.rows[2].out, 1);
});

test('ranked: a perfect split is a tie for the wheel', () => {
  const two = options.slice(0, 2);
  const result = tally('ranked', two, [['a', 'b'], ['b', 'a']]);
  assert.deepEqual(result.winners.sort(), ['a', 'b']);
});

test('ranked: a level final round falls back to overall rank', () => {
  // First choices are 1-1-1, but b is everyone's first or second choice.
  const result = tally('ranked', options, [
    ['a', 'b', 'c'],
    ['b', 'c', 'a'],
    ['c', 'b', 'a'],
  ]);
  assert.deepEqual(result.winners, ['b']);
});

test('ranked: a single ballot picks its first choice', () => {
  const result = tally('ranked', options, [['c', 'a', 'b']]);
  assert.deepEqual(result.winners, ['c']);
});

test('pick one: most votes wins, equal votes tie', () => {
  const win = tally('pick', options, ['a', 'b', 'b']);
  assert.deepEqual(win.winners, ['b']);
  assert.deepEqual(win.rows.map((r) => [r.id, r.votes]), [['b', 2], ['a', 1], ['c', 0]]);
  assert.deepEqual(tally('pick', options, ['a', 'c']).winners.sort(), ['a', 'c']);
});
