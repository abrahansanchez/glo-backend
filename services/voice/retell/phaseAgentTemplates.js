import {retellManagementAgentTemplate} from './managementAgentTemplates.js';
// Offline, unprovisioned. No credentials, agent publication or route activation.
export function retellPhaseAgentTemplate(language='en',origin='https://retell-tools.invalid',{notifications=false,reminders=false}={}){
 const base=retellManagementAgentTemplate(language,origin),staff={type:'string',pattern:'^(ANY|[a-f0-9]{24})$',description:'Required when context requiresStaffSelection. Use current returned calendar ID or ANY only after caller preference; server selects and freezes actual staff.'};
 const tools=base.tools.map(t=>{
  if(!['prepare_booking','check_bundle_availability'].includes(t.name))return t;
  const properties={...t.parameters.properties,staffCalendarId:staff};
  if(t.name==='prepare_booking'&&notifications){properties.notificationConsent={type:'string',enum:['AGREED'],description:'Optional explicit consent for appointment confirmation/change/cancellation SMS to this booking contact, separate from contact reuse and management.'};if(reminders)properties.reminderConsent={type:'string',enum:['AGREED'],description:'Optional additional explicit reminder consent. Requires notificationConsent=AGREED.'};}
  return {...t,parameters:{...t.parameters,properties}};
 });
 const guidance=language==='es'
  ? 'Si el contexto exige profesional, usa sus identificadores actuales. Pregunta si quiere uno concreto o cualquiera disponible; no inventes profesionales. ANY permite al servidor seleccionar uno y fijarlo en la propuesta. Comunica profesional, servicio, precio y duracion devueltos antes de confirmar; no cambies de profesional al confirmar. Solo un elemento del catalogo o una combinacion existente es reservable.'
  : 'When context requires staff selection, use only current returned calendar IDs. Ask specific staff versus any available; never invent staff. ANY lets the server select and freeze staff in the proposal. Read returned staff, service, price and duration before confirmation; never switch staff at commit. Only one catalogue item or existing combination is bookable.';
 const messaging=language==='es'?(notifications?'Pregunta por separado si acepta SMS de esta cita a ese contacto. Solo acuerdo explicito permite notificationConsent=AGREED. Recordatorios requieren permiso adicional reminderConsent=AGREED cuando esten habilitados. No prometas entrega ni confundas verificacion con consentimiento para mensajes.':'No ofrezcas ni prometas SMS de citas; esta configuracion no los habilita.'):(notifications?'Separately ask agreement for this appointment\'s SMS to that contact. Only explicit agreement permits notificationConsent=AGREED. Reminders require additional reminderConsent=AGREED when enabled. Never promise delivery or treat verification as messaging consent.':'Do not offer or promise appointment SMS; this configuration does not enable them.');
 return {...base,mode:'BOOKING_PHASE_UNPROVISIONED',tools,instructions:base.instructions+'\n\n'+guidance+'\n\n'+messaging};
}
