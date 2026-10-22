import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestWriter } from '../src/config.js';

// The state file is rewritten whole from a snapshot, by the minute's save, the
// shutdown save and every steer change. Two saves in flight used to race their
// renames, so an older snapshot ("steer set") could land after a newer one
// ("steer cleared") and bring the steer back at the next start. These drive
// the writer with writes the test finishes by hand, so the ordering is the
// test's and not the scheduler's.

/** A write that finishes when the test says so. */
function heldWrites() {
  /** @type {Array<{ doc: any, release: () => void }>} */
  const writes = [];
  const write = (/** @type {any} */ doc) => new Promise(resolve => { writes.push({ doc, release: () => resolve(undefined) }); });
  return { writes, write };
}

const until = async (/** @type {() => boolean} */ predicate) => { while (!predicate()) await new Promise(r => setImmediate(r)); };

test('a save asked for during a write starts nothing beside it, and one follow-up writes the newest snapshot', async () => {
  let state = 'set';
  const { writes, write } = heldWrites();
  const save = latestWriter(() => state, write);

  const first = save();
  assert.deepEqual(writes.map(w => w.doc), ['set']);
  state = 'set again';
  const second = save();
  state = 'cleared';
  const third = save();
  assert.equal(second, third, 'both join the one follow-up');
  assert.deepEqual(writes.map(w => w.doc), ['set'], 'nothing is written beside the running write');

  writes[0].release();
  await first;
  await until(() => writes.length === 2);
  assert.deepEqual(writes.map(w => w.doc), ['set', 'cleared'], 'the follow-up took its snapshot when it started');
  writes[1].release();
  await third;

  // Idle again: the next save starts at once.
  state = 'later';
  const fourth = save();
  assert.equal(writes.at(-1)?.doc, 'later');
  writes[2].release();
  await fourth;
});

test('a save resolves only once a write begun after it has finished', async () => {
  let state = 0;
  const { writes, write } = heldWrites();
  const save = latestWriter(() => state, write);
  save();
  state = 1;
  let settled = false;
  const awaited = save().then(() => { settled = true; });
  writes[0].release();
  await until(() => writes.length === 2);
  assert.equal(settled, false, 'the write running when it was asked for does not count');
  writes[1].release();
  await awaited;
  assert.equal(settled, true);
  assert.equal(writes[1].doc, 1);
});
