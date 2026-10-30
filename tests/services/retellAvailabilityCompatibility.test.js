import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { isSlotAvailable } from '../../utils/ai/availabilityHelpers.js';
import Appointment from '../../models/Appointment.js';

// Differential against the actual starting commit, not a copied implementation.
// Absolute imports let this historical module use exactly the same synthetic model.
const baseline = 'fe2f0fc24a70f3da739a6488899805c861c479cc';
const source = execFileSync('git', ['show', `${baseline}:utils/ai/availabilityHelpers.js`], {
  cwd: new URL('../../', import.meta.url), encoding: 'utf8', windowsHide: true,
}).replace('"../../models/Appointment.js"', JSON.stringify(new URL('../../models/Appointment.js', import.meta.url).href))
  .replace('"moment-timezone"', JSON.stringify(import.meta.resolve('moment-timezone')));
const historical = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const business = () => ({ _id: '507f1f77bcf86cd799439011', services: [{ name: 'Haircut', durationMinutes: 45 }],
  availability: { timezone: 'America/New_York', defaultServiceDurationMinutes: 30, bufferMinutes: 10,
    businessHours: { tue: { isClosed: false, open: '09:00', close: '18:00' } }, blackoutDates: [] } });

async function observe(fn, args, { conflict = null, failure = false } = {}) {
  const originalFind = Appointment.findOne, originalLog = console.log;
  const queries = [], logs = [], sessions = [];
  Appointment.findOne = query => {
    queries.push(query);
    const result = failure ? Promise.reject(Error('SYNTHETIC_READ_ERROR')) : Promise.resolve(conflict);
    result.session = session => { sessions.push(session); return result; };
    return result;
  };
  console.log = (...values) => logs.push(values);
  try {
    let result, error;
    try { result = await fn(args); } catch (e) { error = e.message; }
    return { result, error, queries, logs, sessions };
  } finally { Appointment.findOne = originalFind; console.log = originalLog; }
}

for (const scenario of ['available', 'conflict', 'closed', 'hours', 'blackout', 'session', 'exclude', 'default duration', 'read error'])
  test(`existing caller matches HEAD outcome/query/logs/session: ${scenario}`, async () => {
    const barber = business(), args = { barber, date: '2030-01-08', time: '3:00 PM', durationMinutes: 45 };
    if (scenario === 'closed') barber.availability.businessHours.tue.isClosed = true;
    if (scenario === 'hours') args.time = '5:30 PM';
    if (scenario === 'blackout') barber.availability.blackoutDates = [{ date: new Date('2030-01-08T17:00:00Z') }];
    if (scenario === 'session') args.session = { syntheticSession: true };
    if (scenario === 'exclude') args.excludeAppointmentId = 'synthetic_appointment';
    if (scenario === 'default duration') delete args.durationMinutes;
    const options = { conflict: scenario === 'conflict' ? { _id: 'synthetic_conflict' } : null, failure: scenario === 'read error' };
    assert.deepEqual(await observe(isSlotAvailable, args, options), await observe(historical.isSlotAvailable, args, options));
  });

test('injected read and logger bypass default model while retaining conflict query and session behavior', async () => {
  const session = { synthetic: true }, calls = [], logs = [];
  const original = Appointment.findOne;
  Appointment.findOne = () => { throw Error('DEFAULT_MODEL_MUST_NOT_RUN'); };
  try {
    const result = await isSlotAvailable({ barber: business(), date: '2030-01-08', time: '3:00 PM', durationMinutes: 45, session,
      observe: (...values) => logs.push(values), findConflict: query => {
        calls.push(query);
        return { session: received => { assert.equal(received, session); return Promise.resolve(null); } };
      } });
    assert.equal(result, true); assert.equal(calls.length, 1); assert.equal(logs.length, 3);
    assert.equal(calls[0].barberId, '507f1f77bcf86cd799439011');
  } finally { Appointment.findOne = original; }
});
