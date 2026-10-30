import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import mongoose from 'mongoose';
import Registration from '../../models/RetellCallRegistration.js';
import { createRetellRegistrationRepository } from '../../services/voice/retell/RegistrationRepository.js';

// Existing cached binary only: no memory-server download path, env, URI or
// credential lookup. The child binds loopback and owns a fresh temporary dbpath.
const binary = join(homedir(), '.cache', 'mongodb-binaries', 'mongod-x64-win32-8.0.32.exe');
test('actual isolated Mongo indexes, competing claims, supersession and expiry (no TTL dependency)', { skip: !existsSync(binary), timeout: 30000 }, async t => {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const dbpath = await mkdtemp(join(tmpdir(), 'glo-retell-mongo-'));
  const child = spawn(binary, ['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dbpath,'--quiet'], { windowsHide: true, stdio: 'ignore' });
  let connection;
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  t.after(async () => { await connection?.close(); child.kill(); await exited; });
  connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/retell_offline`, { serverSelectionTimeoutMS: 15000, autoIndex: false }).asPromise();
  const Model = connection.model('RetellCallRegistration', Registration.schema);
  let time = new Date('2026-10-30T14:00:00Z');
  const repository = createRetellRegistrationRepository({ Model, now: () => time });
  const row = { _id: `CA${'1'.repeat(32)}`, businessId: '507f1f77bcf86cd799439011', agentId: 'agent_en', agentVersion: 1,
    language: 'en', ownerEpoch: 1, revision: 1, attemptId: '12345678-1234-1234-1234-123456789abc', status: 'OBSERVED', expiresAt: new Date(+time + 1000) };
  await repository.observe(row);
  const indexes = await Model.collection.indexes();
  const info = await connection.db.admin().command({ buildInfo: 1 });
  assert.equal(info.version, '8.0.32');
  t.diagnostic(JSON.stringify({ database: 'ISOLATED_LOOPBACK', version: info.version, indexes }));
  assert.ok(indexes.some(i => i.key._id === 1 && i.name === '_id_'));
  assert.ok(indexes.some(i => i.key.attemptId === 1 && i.unique));
  assert.ok(indexes.some(i => i.key.providerCallId === 1 && i.unique && i.partialFilterExpression));
  assert.ok(indexes.every(i => i.expireAfterSeconds === undefined));
  const claims = await Promise.all(Array.from({ length: 20 }, () => repository.claim(row._id, 1, time)));
  assert.equal(claims.filter(Boolean).length, 1);
  await assert.rejects(Model.create({ ...row, _id: `CA${'2'.repeat(32)}` }), e => e.code === 11000);
  await repository.bind(claims.find(Boolean), 'retell_one', time);
  await repository.event({ attemptId: row.attemptId, callId: 'retell_one', agentId: 'agent_en', agentVersion: 1, ended: false }, time);
  assert.ok(await repository.findByProviderCallId('retell_one'));
  await assert.rejects(Model.create({ ...row, _id: `CA${'3'.repeat(32)}`, attemptId: 'different_attempt', providerCallId: 'retell_one' }), e => e.code === 11000);
  time = new Date(+time + 1000);
  assert.equal(await repository.findByProviderCallId('retell_one'), null); // exactly now; row remains stored
  assert.equal(await Model.countDocuments({ _id: row._id }), 1);
  const other = { ...row, _id: `CA${'4'.repeat(32)}`, attemptId: 'other_attempt', expiresAt: new Date(+time + 1000) };
  await repository.observe(other);
  const owner = await repository.claim(other._id, 1, time);
  const outcomes = await Promise.all(Array.from({ length: 10 }, () => repository.supersede(other._id, 1)));
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(await repository.bind(owner, 'late_call', time), null);
  assert.equal(await repository.claim(other._id, 2, time), null);
  const saved = await Model.findById(other._id).lean(); assert.equal(saved.ownerEpoch, 2); assert.equal(saved.status, 'SUPERSEDED');
});
