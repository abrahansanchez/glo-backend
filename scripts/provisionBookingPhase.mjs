import {invitationModels} from '../models/StaffInvitation.js';
// Manual operator utility. No execution during offline development.
// Default is read-only. --apply only adds new phase collections/indexes.
import mongoose from 'mongoose';
import {admissionModel} from '../models/BookingPhaseAdmission.js';
mongoose.set('autoIndex',false);mongoose.set('autoCreate',false);
const apply=process.argv.slice(2).length===1&&process.argv[2]==='--apply';
if(process.argv.slice(2).some(v=>!['--apply','--check'].includes(v))||process.argv.slice(2).length>1)throw Error('INVALID_MODE');
let connection;
try{
 if(!process.env.MONGO_URI)throw Error('MONGO_CONFIGURATION_REQUIRED');
 const [{default:Calendar},{default:Membership},{default:Proposal},management,{calendarModels},{notificationModels},{default:Appointment},{default:Fence},{default:Registration},{default:Budget},{default:Run},{default:Delivery},{verifyDeclaredIndexes}]=await Promise.all([import('../models/StaffCalendar.js'),import('../models/StaffMembership.js'),import('../models/StaffBookingProposal.js'),import('../models/AppointmentManagement.js'),import('../models/ExternalCalendar.js'),import('../models/AppointmentNotification.js'),import('../models/Appointment.js'),import('../models/ScheduleFence.js'),import('../models/RetellCallRegistration.js'),import('../models/RetellSandboxBudget.js'),import('../models/RetellDevelopmentRun.js'),import('../models/MessageDelivery.js'),import('../services/booking/verifyIndexes.js')]);
 connection=await mongoose.createConnection(process.env.MONGO_URI,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:5000,socketTimeoutMS:10000}).asPromise();
 const clone=M=>connection.models[M.modelName]||connection.model(M.modelName,M.schema.clone());
 const prerequisites=[Appointment,Fence,Registration,Budget,Run,Delivery].map(clone);
 // Existing prerequisites are inspected only, never created or altered here.
 for(const M of prerequisites){const indexes=await M.collection.indexes();const required=M.modelName==='Appointment'?M.schema.indexes().filter(([k,o])=>o.unique&&k['bookingCommand.idempotencyKey']):M.modelName==='RetellCallRegistration'?M.schema.indexes().filter(([,o])=>o.unique):M.modelName==='MessageDelivery'?M.schema.indexes().filter(([,o])=>o.unique):[];for(const [k,o]of required)if(!indexes.some(i=>JSON.stringify(i.key)===JSON.stringify(k)&&i.unique===true&&JSON.stringify(i.partialFilterExpression||null)===JSON.stringify(o.partialFilterExpression||null)&&!!i.sparse===!!o.sparse))throw Error('EXISTING_PREREQUISITE_INCOMPATIBLE');console.log(JSON.stringify({collection:M.collection.name,status:'EXISTING_PREREQUISITE_VERIFIED'}));}
 const phase=[Calendar,Membership,Proposal,...Object.values(management)].map(clone),all=[...new Set([...phase,...Object.values(calendarModels(connection)),...Object.values(notificationModels(connection)),admissionModel(connection),...Object.values(invitationModels(connection))])];
 for(const M of all){const exists=await connection.db.listCollections({name:M.collection.name},{nameOnly:true}).hasNext();if(!exists){if(!apply)throw Error('PHASE_COLLECTION_MISSING');await M.createCollection();}
  const indexes=await M.collection.indexes();for(const [key,options]of M.schema.indexes()){const same=indexes.find(i=>JSON.stringify(i.key)===JSON.stringify(key));if(same&&(!!same.unique!==!!options.unique||same.expireAfterSeconds!==options.expireAfterSeconds||JSON.stringify(same.partialFilterExpression||null)!==JSON.stringify(options.partialFilterExpression||null)||!!same.sparse!==!!options.sparse))throw Error('PHASE_INDEX_INCOMPATIBLE');if(!same){if(!apply)throw Error('PHASE_INDEX_MISSING');await M.collection.createIndex(key,options);}}
 }
 await verifyDeclaredIndexes(Object.fromEntries(all.map(m=>[m.modelName,m])),{ttlAllowed:['ManagementChallenge','ManagementRate','ManagementSelection','CalendarOAuthState','StaffInvitationRate']});
 const hello=await connection.db.admin().command({hello:1});console.log(JSON.stringify({mode:apply?'ADDITIVE_APPLY':'READ_ONLY',collections:all.map(m=>m.collection.name).sort(),transactionTopology:hello.setName?'REPLICA_SET':hello.msg==='isdbgrid'?'SHARDED':'UNVERIFIED',status:'BOOKING_PHASE_INDEXES_VERIFIED',documentsInserted:0}));
}catch{console.error('BOOKING_PHASE_PREREQUISITE_MISSING_OR_INCOMPATIBLE');process.exitCode=1;}finally{await connection?.close();}
