import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import mongoose from 'mongoose';
import express from 'express';
import twilio from 'twilio';
import Registration from '../../models/RetellCallRegistration.js';
import Budget from '../../models/RetellSandboxBudget.js';
import Proposal from '../../models/RetellBookingProposal.js';
import Receipt from '../../models/RetellTranscriptReceipt.js';
import VoiceRecord from '../../models/VoiceCallRecord.js';
import Appointment from '../../models/Appointment.js';
import Fence from '../../models/ScheduleFence.js';
import { installRetellSandbox } from '../../services/voice/retell/installSandbox.js';
import { RetellBookingService } from '../../services/voice/retell/BookingService.js';
export const binary = join(homedir(), '.cache', 'mongodb-binaries', 'mongod-x64-win32-8.0.32.exe');
export const mongoAvailable = existsSync(binary);
export const secret = 'SYNTHETIC_RETELL_ACTIONS_KEY';
export const origin = 'https://synthetic.invalid';
let counter = 0;
export async function startHarness() {
  const socket = net.createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const dbpath = await mkdtemp(join(tmpdir(), 'glo-retell-actions-'));
  const child = spawn(binary, ['--bind_ip','127.0.0.1','--port',String(port),'--dbpath',dbpath,'--replSet','retell_offline','--quiet'],
    { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise(r => { child.once('exit', r); child.once('error', r); });
  let connection;
  try {
    connection = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/retell_actions?directConnection=true`,
      { serverSelectionTimeoutMS: 15000, autoIndex: false, autoCreate: false }).asPromise();
    await connection.db.admin().command({ replSetInitiate: { _id: 'retell_offline', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    for (let i = 0; i < 100; i++) {
      if ((await connection.db.admin().command({ hello: 1 })).isWritablePrimary) break;
      await new Promise(r => setTimeout(r, 100));
    }
    const models = Object.fromEntries([['Registration',Registration],['Budget',Budget],['Proposal',Proposal],['Receipt',Receipt],
      ['VoiceRecord',VoiceRecord],['Appointment',Appointment],['Fence',Fence]].map(([key, model]) => [key, connection.model(model.modelName, model.schema.clone())]));
    models.Barber = connection.model('ActionsBarber', new mongoose.Schema({ services: Array, availability: Object }, { collection: 'barbers' }));
    for (const Model of Object.values(models)) { await Model.createCollection(); await Model.createIndexes(); }
    return { connection, models, close: async () => { await connection.close(); child.kill(); await exited; } };
  } catch (e) { await connection?.close(); child.kill(); await exited; throw e; }
}
export async function fixture(harness, options = {}) {
  const n = ++counter, parent = `CA${n.toString(16).padStart(32,'0')}`, childSid = `CA${(n+10000).toString(16).padStart(32,'0')}`;
  const callId = `call_actions_${n}`, businessId = options.businessId || String(new mongoose.Types.ObjectId());
  let time = Date.parse('2026-11-03T14:00:00Z');
  const now = () => new Date(time), models = harness.models;
  if (!await models.Barber.findById(businessId)) await models.Barber.create({ _id: businessId,
    services: [{ name:'Haircut',price:25,durationMinutes:30 },{ _id:'combo_item',name:'Haircut + Beard',price:40,durationMinutes:60 }],
    availability: { timezone:'America/New_York',bufferMinutes:10,blackoutDates:[],businessHours:Object.fromEntries(
      ['sun','mon','tue','wed','thu','fri','sat'].map(d=>[d,{isClosed:false,open:'09:00',close:'18:00'}])) } });
  const app = express();
  const bookingDependencies = { ProposalModel: models.Proposal, BarberModel: models.Barber, AppointmentModel: models.Appointment,
    atomicOptions: { ScheduleFenceModel: models.Fence, mongooseConnection: harness.connection, startSession: () => harness.connection.startSession() }, ...options.bookingDependencies };
  const installed = installRetellSandbox(app, { enabled:true,executionEnabled:true,businessId,budgetId:`actions_budget_${n}`,
    agentsByBusiness:{[businessId]:{agentId:'agent_actions',agentVersion:0,language:options.language || 'en'}},
    twilioAuth:{authToken:secret,appBaseUrl:origin},signingKey:secret,
    provider:{registerPhoneCall:async p=>({call_id:callId,agent_id:p.agent_id,agent_version:p.agent_version,call_status:'registered'})},
    models:{BarberModel:models.Barber,AppointmentModel:models.Appointment},RegistrationModel:models.Registration,BudgetModel:models.Budget,
    resolveBusiness:async()=>({businessId}),now,bookingEnabled:options.bookingEnabled !== false,bookingDependencies,
    transcriptPolicy:{enabled:options.transcriptsEnabled === true,retentionDays:30},
    transcriptDependencies:{VoiceCallRecordModel:models.VoiceRecord,ReceiptModel:models.Receipt} });
  const req = (path, body) => ({ originalUrl:path,body,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature(secret,`${origin}${path}`,body)} });
  await installed.handoff.observeIncoming(req('/api/voice/incoming',{CallSid:parent,To:'+15550000001',From:'+15550000003'}),businessId);
  const bridged = await installed.handoff.fallback(req('/api/voice/dial-fallback',{CallSid:parent,To:'+15550000001',DialCallStatus:'no-answer'}));
  if (!bridged.twiml.includes('<Sip')) throw Error('FIXTURE_BRIDGE_FAILED');
  await installed.handoff.webhook(req('/api/voice/retell-sandbox/screen',{ParentCallSid:parent,CallSid:childSid}), 'screen');
  const row = await installed.repository.findByParentCallId(parent);
  const call = {call_id:callId,agent_id:'agent_actions',agent_version:0,call_status:'ongoing',metadata:{glo_registration_attempt:row.attemptId}};
  await installed.lifecycle.handleEvent({event:'call_started',call});
  const authorize = async () => { const b = await installed.repository.findByProviderCallId(callId); if(!b || !b.bookingAllowed) throw Object.assign(Error('CALL_NOT_AUTHORIZED'),{reasonCode:'CALL_NOT_AUTHORIZED'}); return b; };
  const service = new RetellBookingService({...bookingDependencies,repository:installed.repository,authorize,now});
  const context = await service.reads().context({businessId,language:options.language || 'en'});
  const args = {serviceIds:[context.data.services[0].id],date:'2026-11-03',time:'15:00',businessRevision:context.businessRevision,clientName:'Alex Synthetic',contactNumber:'+15550000004'};
  return {...installed, app,service,models,parent,callId,call,businessId,args,authorize,now,advance:ms=>{time+=ms;},req,context};
}
