'use strict';
// The NULL QuotaSignalSource: a harness that has no quota concept at all
// (shell terminals) — and the engine's LOUD-FAILURE fallback for a backend
// id nobody registered. Every member is the honest "nothing": no reading, no
// signal, no probe rung, no auth verdict. Frozen so a consumer can never
// mutate the shared instance into a fake source.
//
// `toLimitSet` returns an EMPTY typed set (src/quota-model.js), never null:
// "this harness has no limits" is a statement, and every reader of a LimitSet
// must be able to ask it the same questions and get "no claim" back. A null
// would make each caller invent its own empty case.
const { EMPTY_SET, makeLimitSet } = require('../quota-model.js');

const NULL_QUOTA = Object.freeze({
  normalize: () => null,
  signalFromStream: () => null,
  probe: null,
  classifyAuthFailure: () => false,
  toLimitSet: ({ identity = null, source = null, fetchedAt = null } = {}) =>
    makeLimitSet({ identity, source, fetchedAt, limits: [] }),
  limitSetFromSnapshot: (_snap, { identity = null, source = null } = {}) =>
    makeLimitSet({ identity, source, limits: [] }),
});

module.exports = { NULL_QUOTA, EMPTY_SET };
