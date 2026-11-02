import { createHash, randomUUID } from 'node:crypto';
import Proposal from '../../../models/RetellBookingProposal.js';
import Barber from '../../../models/Barber.js';
import Appointment from '../../../models/Appointment.js';
import { ReadOnlyBusinessTools } from './ReadOnlyBusinessTools.js';
import { createIdempotentAppointment, reconcileIdempotentAppointment } from '../../booking/createIdempotentAppointment.js';
import { createAppointmentAtomically, ScheduleConflictError } from '../../booking/atomicScheduleMutation.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reasonCode => Object.assign(Error(reasonCode), { reasonCode });
const result = (status, reasonCode, extra = {}) => ({ status, reasonCode, ...extra });
export class RetellBookingService {
  constructor({ repository, authorize, ProposalModel = Proposal, BarberModel = Barber, AppointmentModel = Appointment,
    atomicOptions = {}, create = createIdempotentAppointment, reconcile = reconcileIdempotentAppointment, now = () => new Date() }) {
    Object.assign(this, { repository, authorize, ProposalModel, BarberModel, AppointmentModel, atomicOptions, create, reconcile, now });
    this.ready = Promise.resolve().then(async () => { await ProposalModel.init(); await ProposalModel.createIndexes(); });
  }
  scope(binding) { return { callId: binding.callId, businessId: binding.businessId, parentCallSid: binding.parentCallSid }; }
  async lock(binding, token) {
    const active = await this.authorize();
    if (active.callId !== binding.callId || active.businessId !== binding.businessId) throw fail('CALL_NOT_AUTHORIZED');
    const row = await this.repository.findByParentCallId(binding.parentCallSid);
    if (!row || row.bookingAllowed !== true) throw fail('CALL_NOT_AUTHORIZED');
    return this.repository.Model.findOneAndUpdate({ _id: row._id, ownerEpoch: row.ownerEpoch, status: 'ACTIVE', bookingAllowed: true,
      bookingLock: { $exists: false }, expiresAt: { $gt: this.now() },
      ...(row.bridgeRequired ? { bridgeScreenedAt: { $exists: true }, bridgeExpiresAt: { $gt: this.now() } } : {}) },
    { $set: { bookingLock: token }, $inc: { revision: 1 } }, { new: true }).lean();
  }
  async unlock(parent, token) {
    await this.repository.Model.updateOne({ _id: parent, bookingLock: token }, { $unset: { bookingLock: 1 }, $inc: { revision: 1 } });
  }
  reads(session) {
    return new ReadOnlyBusinessTools({ now: this.now,
      businessRepository: { findById: id => { const q = this.BarberModel.findById(id); return (session ? q.session(session) : q).lean(); } },
      appointmentRepository: { findConflict: query => { const q = this.AppointmentModel.findOne(query); return session ? q.session(session) : q; } } });
  }
  async checked(binding, args, session) {
    const tools = this.reads(session), snapshot = await tools.snapshot(binding);
    if (snapshot.businessRevision !== args.businessRevision) throw fail('BUSINESS_CHANGED');
    const service = snapshot.data.services.find(s => s.id === args.serviceIds[0]);
    if (!service) throw fail('UNKNOWN_SERVICE');
    const availability = await tools.availability(binding, args);
    if (availability.status !== 'OK') throw fail(availability.reasonCode);
    if (!availability.data.available) throw Object.assign(fail('UNAVAILABLE'), { availability: availability.data });
    // Exact catalogue mapping: never feed a legacy handle to the name-based helper.
    const raw = snapshot.raw.services.find(s => String(s._id ?? s.id ?? `legacy:${hash(s.name)}`) === service.id);
    if (!raw || typeof raw.name !== 'string' || raw.durationMinutes !== service.durationMinutes) throw fail('INVALID_CATALOGUE');
    return { service, serviceName: raw.name, availability: availability.data };
  }
  request(proposal) {
    const f = proposal.facts;
    return { barberId: proposal.businessId, service: f.serviceName, clientName: f.clientName, callerNumber: f.contactNumber,
      date: f.date, time: f.time, timeZone: f.timeZone, commandId: proposal._id, idempotencyKey: `retell:${proposal._id}`, proposalVersion: 1 };
  }
  async prepare(binding, args) {
    await this.ready;
    if (!/^\+[1-9]\d{7,14}$/.test(binding.trustedCallerNumber || '')) return result('REJECTED', 'TRUSTED_CALLER_NUMBER_REQUIRED');
    const token = randomUUID(), row = await this.lock(binding, token);
    if (!row) return result('REJECTED', 'BOOKING_BUSY');
    try {
      const previous = row.bookingProposalId && await this.ProposalModel.findById(row.bookingProposalId).lean();
      if (previous && ['COMMITTING','UNKNOWN'].includes(previous.status)) return result('UNKNOWN', 'SETTLEMENT_UNKNOWN');
      // A new well-formed preparation invalidates previous confirmation even if
      // its requested slot/bundle is subsequently rejected or unsupported.
      await this.repository.Model.updateOne({ _id: row._id, bookingLock: token }, { $unset: { bookingProposalId: 1 }, $inc: { revision: 1 } });
      if (args.serviceIds.length !== 1) return result('UNSUPPORTED', 'MULTI_ITEM_BOOKING_UNSUPPORTED');
      const checked = await this.checked(binding, args);
      const facts = { serviceIds: [...args.serviceIds], serviceName: checked.serviceName, serviceLabel: checked.service.label,
        durationMinutes: checked.service.durationMinutes, price: checked.service.price, date: args.date, time: args.time,
        timeZone: checked.availability.timeZone, businessRevision: args.businessRevision,
        clientName: args.clientName.trim(), contactNumber: args.contactNumber, trustedCallerNumber: binding.trustedCallerNumber };
      const id = randomUUID(), expiresAt = new Date(Math.min(+this.now() + 60000, +new Date(binding.expiresAt),
        row.bridgeRequired ? +new Date(row.bridgeExpiresAt) : Infinity));
      await this.ProposalModel.create({ _id: id, ...this.scope(binding), facts, factsHash: hash(facts), expiresAt, status: 'PREPARED' });
      await this.authorize();
      const updated = await this.repository.Model.findOneAndUpdate({ _id: row._id, bookingLock: token, ownerEpoch: row.ownerEpoch, status: 'ACTIVE',
        expiresAt: { $gt: this.now() }, ...(row.bridgeRequired ? { bridgeExpiresAt: { $gt: this.now() } } : {}) },
      { $set: { bookingProposalId: id }, $inc: { revision: 1 } }, { new: true }).lean();
      if (!updated || +expiresAt <= +this.now()) throw fail('CALL_NOT_AUTHORIZED');
      return result('PREPARED', null, { proposalId: id, expiresAt: expiresAt.toISOString(), requiresExplicitConfirmation: true,
        summary: { clientName: facts.clientName, contactNumber: facts.contactNumber, service: facts.serviceLabel,
          date: facts.date, time: facts.time, timeZone: facts.timeZone, price: facts.price, durationMinutes: facts.durationMinutes }, booked: false });
    } finally { await this.unlock(row._id, token); }
  }
  async settle(proposal, settled) {
    if (settled.success && settled.appointmentId) {
      await this.ProposalModel.updateOne({ _id: proposal._id, status: { $in: ['COMMITTING','UNKNOWN','BOOKED'] } },
        { $set: { status: 'BOOKED', appointmentId: settled.appointmentId } });
      await this.unlock(proposal.parentCallSid, proposal.commitToken);
      return result('BOOKED', null, { appointmentId: settled.appointmentId, replayed: settled.replayed === true });
    }
    if (settled.reason === 'SETTLEMENT_UNKNOWN' || settled.reason === 'PERSISTENCE_ERROR') {
      await this.ProposalModel.updateOne({ _id: proposal._id, status: 'COMMITTING' }, { $set: { status: 'UNKNOWN' } });
      return result('UNKNOWN', 'SETTLEMENT_UNKNOWN');
    }
    await this.ProposalModel.updateOne({ _id: proposal._id, status: { $in: ['COMMITTING','UNKNOWN'] } }, { $set: { status: 'FAILED' } });
    await this.unlock(proposal.parentCallSid, proposal.commitToken);
    return result('REJECTED', settled.reason || 'BOOKING_FAILED');
  }
  async commit(binding, args) {
    await this.ready;
    if (args.confirmation !== 'AFFIRMATIVE') return result('REJECTED', 'EXPLICIT_CONFIRMATION_REQUIRED');
    let proposal = await this.ProposalModel.findOne({ _id: args.proposalId, ...this.scope(binding) }).lean();
    const row = await this.repository.findByParentCallId(binding.parentCallSid);
    if (!proposal || row?.bookingProposalId !== proposal._id) return result('REJECTED', 'STALE_OR_FOREIGN_PROPOSAL');
    if (hash(proposal.facts) !== proposal.factsHash) return result('REJECTED', 'IDEMPOTENCY_CONFLICT');
    const dependencies = { findBarberById: id => this.BarberModel.findById(id).lean(),
      findByIdempotencyKey: (barberId, key) => this.AppointmentModel.findOne({ barberId, 'bookingCommand.idempotencyKey': key }) };
    if (['COMMITTING','UNKNOWN'].includes(proposal.status)) return this.settle(proposal, await this.reconcile(this.request(proposal), dependencies));
    if (proposal.status === 'BOOKED') return result('BOOKED', null, { appointmentId: proposal.appointmentId, replayed: true });
    if (+new Date(proposal.expiresAt) <= +this.now()) return result('REJECTED', 'PROPOSAL_EXPIRED');
    if (proposal.status !== 'PREPARED') return result('REJECTED', 'PROPOSAL_NOT_COMMITTABLE');
    const token = randomUUID(), owned = await this.lock(binding, token);
    if (!owned) return result('REJECTED', 'BOOKING_BUSY');
    let dispatched = false, effectStarted = false;
    try {
      if (owned.bookingProposalId !== proposal._id) return result('REJECTED', 'STALE_OR_FOREIGN_PROPOSAL');
      await this.checked(binding, proposal.facts);
      proposal = await this.ProposalModel.findOneAndUpdate({ _id: proposal._id, status: 'PREPARED', expiresAt: { $gt: this.now() } },
        { $set: { status: 'COMMITTING', commitToken: token, confirmedAt: this.now(), confirmationFactsHash: proposal.factsHash } }, { new: true }).lean();
      if (!proposal) return result('REJECTED', 'PROPOSAL_EXPIRED');
      const createAppointment = async values => {
        effectStarted = true;
        // Repeat authorization and exact catalogue/availability validation within
        // the shared transaction; writing the registration fences revocation races.
        const atomic = await createAppointmentAtomically({ ...values, notificationsSuppressed: true }, { ...this.atomicOptions, AppointmentModel: this.AppointmentModel, BarberModel: this.BarberModel,
          beforeCreate: async ({ session }) => {
            await this.authorize();
            try { await this.checked(binding, proposal.facts, session); }
            catch (e) { if (e.reasonCode === 'UNAVAILABLE') throw new ScheduleConflictError(); throw e; }
            const fenced = await this.repository.Model.updateOne({ _id: owned._id, ownerEpoch: owned.ownerEpoch, status: 'ACTIVE', bookingAllowed: true,
              bookingLock: token, bookingProposalId: proposal._id, expiresAt: { $gt: this.now() },
              ...(owned.bridgeRequired ? { bridgeExpiresAt: { $gt: this.now() } } : {}) }, { $inc: { bookingFence: 1 } }, { session });
            if (fenced.matchedCount !== 1 || +new Date(proposal.expiresAt) <= +this.now()) throw fail('CALL_NOT_AUTHORIZED');
          } });
        if (atomic.replayed && !atomic.requestHashMatches) throw fail('IDEMPOTENCY_CONFLICT');
        return atomic.appointment;
      };
      dispatched = true;
      const outcome = await this.create(this.request(proposal), { ...dependencies,
        getServiceDuration: () => proposal.facts.durationMinutes,
        checkAvailability: async () => { await this.authorize(); try { await this.checked(binding, proposal.facts); return true; }
          catch (e) { if (e.reasonCode === 'UNAVAILABLE') return false; throw e; } }, createAppointment });
      if (['SETTLEMENT_UNKNOWN','PERSISTENCE_ERROR'].includes(outcome.reason))
        return this.settle(proposal, await this.reconcile(this.request(proposal), dependencies));
      return this.settle(proposal, outcome);
    } catch (e) {
      if (dispatched && !effectStarted && e.reasonCode) return this.settle(proposal, { success: false, reason: e.reasonCode });
      if (dispatched) return this.settle(proposal, await this.reconcile(this.request(proposal), dependencies));
      throw e;
    } finally { if (!dispatched) await this.unlock(owned._id, token); }
  }
}
