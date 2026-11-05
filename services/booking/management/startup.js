export async function mountManagementFoundation(app,{env=process.env,dependencies={}}={}) {
 if(env.GLO_APPOINTMENT_MANAGEMENT_ENABLED!=='true')return {enabled:false};
 try {
  const {composeRetellManagement}=await import('./composeRetellManagement.js');
  // Owner grants/delegation have no provider or call authority. Phone methods
  // remain inaccessible here; signed phone routes use their own real repository.
  const composition=composeRetellManagement({enabled:true,key:env.RETELL_MANAGEMENT_HASH_KEY,capabilities:['DELEGATE'],repository:{fenceManagement:()=>{throw Error('CALL_AUTHORITY_REQUIRED');}},...dependencies});
  await composition.ready();app.locals.appointmentManagement=composition;return {enabled:true};
 }catch{return {enabled:false,reasonCode:'MANAGEMENT_CONFIGURATION_OR_INDEX_PREREQUISITE_MISSING'};}
}
