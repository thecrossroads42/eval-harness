// Unit tests for the trajectory seed step (applySetup in runner.js) — the
// mechanism that turns a scenario's `setup` block into prior state for a
// returning-user run. It seeds over the REAL user-facing HTTP API (PUT
// /api/action-plan, /api/notes) so the harness still only touches public
// endpoints. These stub fetch and assert the call shape + the fail-loud
// contract: an unsupported setup key (state the harness can't yet seed) must
// THROW, never silently under-seed (which would pass/fail a run for the wrong
// reason). No network, no backend.
//
// Run: node --test setup.test.js

import { test } from 'node:test';
import assert from 'node:assert';
import { applySetup } from './runner.js';

// Swap a recording stub into global.fetch (applySetup looks fetch up at call
// time, so per-test replacement is enough). Returns the captured calls.
function recordingFetch(responder = () => ({ ok: true })) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({
      url: String(url),
      method: opts.method,
      auth: opts.headers?.Authorization,
      body: opts.body ? JSON.parse(opts.body) : null,
    });
    return responder();
  };
  return calls;
}

test('applySetup: no setup block → no calls (existing scenarios unaffected)', async () => {
  const calls = recordingFetch();
  await applySetup('user_x', undefined);
  await applySetup('user_x', null);
  assert.equal(calls.length, 0);
});

test('applySetup: seeds the action plan via PUT /api/action-plan with bearer auth', async () => {
  const calls = recordingFetch();
  await applySetup('user_abc', { actionPlan: '1. do the thing' });
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.ok(c.url.endsWith('/api/action-plan'), 'hits the action-plan endpoint');
  assert.equal(c.method, 'PUT');
  assert.equal(c.auth, 'Bearer user_abc', 'authenticates as the user');
  assert.deepEqual(c.body, { actionPlan: '1. do the thing' });
});

test('applySetup: seeds notes too when present', async () => {
  const calls = recordingFetch();
  await applySetup('user_abc', { actionPlan: 'p', notes: 'my notes' });
  const endpoints = calls.map((c) => c.url.slice(c.url.indexOf('/api/'))).sort();
  assert.deepEqual(endpoints, ['/api/action-plan', '/api/notes']);
  assert.equal(calls.find((c) => c.url.endsWith('/api/notes')).body.notes, 'my notes');
});

test('applySetup: an unsupported setup key throws (no silent under-seeding)', async () => {
  const calls = recordingFetch();
  await assert.rejects(
    () => applySetup('user_abc', { heldForks: [{ fork: 'x' }] }),
    /unsupported key/,
  );
  assert.equal(calls.length, 0, 'nothing is seeded when the setup is unsupported');
});

test('applySetup: a non-ok seed response throws (the run fails loudly)', async () => {
  recordingFetch(() => ({ ok: false, status: 500 }));
  await assert.rejects(
    () => applySetup('user_abc', { actionPlan: 'p' }),
    /seed action plan failed \(status 500\)/,
  );
});
