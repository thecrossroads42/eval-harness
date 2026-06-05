// =============================================================================
// Auth backend (injection seam). The engine never provisions users itself — it
// asks this module to. Two implementations plug in here:
//
//   - DEFAULT (BYO): the engine runs against ONE pre-existing account using a
//     token (config.token — a `tcr_` API key or a user id). No user creation,
//     crediting, or deletion; the account funds itself. This is what a public
//     user gets, and it is the same BYO-key move the CLI got.
//   - INJECTED: an operator supplies an admin-API backend that mints a throwaway
//     user per run, grants it credit, and deletes it after — installed via the
//     HARNESS_AUTH_BACKEND env hook (see bin/harness), which imports that module
//     and passes it to __setAuthBackend. Its exports override the BYO defaults.
//
// checkBackend is engine (it pings the public /api/voices), identical either way,
// so it lives here directly rather than in the injectable surface.
// =============================================================================

import { apiUrl, token } from './config.js';

function byoProvision() {
  if (!token) {
    throw new Error(
      'No auth configured. Set HARNESS_TOKEN to your `tcr_` API key to run against your own ' +
      'account, or set HARNESS_AUTH_BACKEND to a module that provisions throwaway users.'
    );
  }
  // The CLI authenticates with this token directly (a `tcr_` key, or a user id).
  return { userId: token, email: null };
}

// The injectable surface. Each method an operator backend omits keeps this BYO
// default. A BYO run touches exactly one real account, so crediting / deletion /
// admin-only reads are no-ops, and there are no throwaway users to prune.
const DEFAULT_BACKEND = {
  provisionUser: async () => byoProvision(),
  grantCredits: async () => undefined,
  deleteUser: async () => undefined,
  fetchVisitDebug: async () => null,
  listHarnessUsers: async () => [],
};

let backend = DEFAULT_BACKEND;

// Install an operator-supplied backend (any object/module exposing a subset of
// the surface above; unspecified methods keep the BYO default).
export function __setAuthBackend(impl) {
  backend = { ...DEFAULT_BACKEND, ...impl };
}

export const provisionUser = (...a) => backend.provisionUser(...a);
export const grantCredits = (...a) => backend.grantCredits(...a);
export const deleteUser = (...a) => backend.deleteUser(...a);
export const fetchVisitDebug = (...a) => backend.fetchVisitDebug(...a);
export const listHarnessUsers = (...a) => backend.listHarnessUsers(...a);

export async function checkBackend() {
  try {
    const res = await fetch(`${apiUrl}/api/voices`);
    return res.ok;
  } catch {
    return false;
  }
}
