// Author-written semantic labels. This module never imports or runs an interpreter.
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const directory = new URL('./', import.meta.url);
const D = '2026-10-24', NEXT = '2026-10-25';
const catalogue = [{canonical:'Haircut',aliases:['hair cut','corte','corte de pelo','cortarme el pelo']},
  {canonical:'Beard Trim',aliases:['recorte de barba','barba','beard cut']},{canonical:'Color',aliases:[]}];
const hours = Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(day=>[day,{open:'09:00',close:'18:00',isClosed:day==='sun'}]));
const empty = {service:null,additionalServices:[],date:null,time:null,name:null};
const contexts = {
  empty, service:{...empty,service:'Haircut'}, dated:{...empty,service:'Haircut',date:D},
  selected:{...empty,service:'Haircut',date:D,time:'15:00'},
  ready:{...empty,service:'Haircut',date:D,time:'15:00',name:'Example'},
  compound:{...empty,service:'Haircut',additionalServices:['Beard Trim'],date:D,time:'15:00',name:'Example'},
  offered:{...empty,service:'Haircut',date:D,name:'Example'},
};
const alternatives = ['14:00','15:00','16:00'].map(time=>({date:D,time}));
const effects=(availability=0,booking=0,sms=0)=>({availability,booking,sms});
const cases=[];
function expected(state,intents,options={}) {
  return {expectedIntents:[...new Set(intents)],expectedServicesInMentionOrder:state.service?[state.service,...state.additionalServices]:[],
    expectedDate:state.date,expectedExactTime:state.time,expectedDaypart:null,expectedLowerBound:null,expectedUpperBound:null,
    expectedName:state.name,expectedConfirmation:'none',expectedCorrectionTarget:null,expectedEffects:effects(),
    expectedClarification:false,ambiguityReason:null,...options};
}
function add(category,language,text,intents,patch={},options={}) {
  const context=options.context||'empty', start=structuredClone(contexts[context]);
  const state={...start,...patch};
  const label=expected(state,intents,options.label);
  const id=`${category}-${language}-${String(cases.filter(c=>c.category===category&&c.language===language).length+1).padStart(2,'0')}`;
  cases.push({id,language,category,sourceType:options.real?'supplied_real_phrase':'synthetic',referenceDate:'2026-10-23',timezone:'America/New_York',
    businessLanguage:options.businessLanguage||(cases.length%2?language:(language==='en'?'es':'en')),
    transcriptionLanguage:options.businessLanguage||(cases.length%2?language:(language==='en'?'es':'en')),
    serviceCatalogue:catalogue,businessHours:hours,initialProposal:start,
    currentRequirement:context==='empty'?'NEEDS_SERVICE':context==='service'?'NEEDS_DATE':context==='dated'||context==='offered'?'NEEDS_TIME':context==='selected'?'NEEDS_NAME':'NEEDS_CONFIRMATION',
    lastResponsePurpose:context==='ready'||context==='compound'?'PRE_BOOKING_CONFIRMATION':context==='offered'?'SCHEDULING_ALTERNATIVES':context==='selected'?'ASK_NAME':context==='dated'?'ASK_TIME':context==='service'?'ASK_DATE':'ASK_SERVICE',
    alternatives:context==='offered'?alternatives:[],
    turns:[{itemId:`${id}:1`,text,...label}],...label,
    tags:options.tags||[],representationLimit:options.representationLimit||null});
}
function pair(category,en,es,intents,patch={},options={}) {
  for(const [language,phrases] of [['en',en],['es',es]]) for(const text of phrases) add(category,language,text,intents,patch,options);
}
const booking=['BOOK_REQUEST','SET_SERVICE','SET_DATE','SET_TIME'];
pair('direct_booking',[
  'Please book a haircut for Saturday at 3 pm.','I would like a haircut on October 24 at 15:00.','Can you arrange a haircut tomorrow at three in the afternoon?'],[
  'Quiero reservar un corte de pelo el sábado a las 3 pm.','Necesito una cita para corte mañana a las tres de la tarde.','Un corte de pelo para el 24 de octubre a las 15:00, por favor.'],booking,{service:'Haircut',date:D,time:'15:00'},{label:{expectedEffects:effects(1),expectedClarification:true}});
const embeddedEn=['I need a haircut for tomorrow. What times do you have available in the afternoon?',
  'I would like a haircut tomorrow; which afternoon times can I choose?','Can I book a haircut for tomorrow, and what afternoon openings do you have?',
  'A haircut tomorrow would be great. What is open after lunch?'];
const embeddedEs=['Necesito cortarme el pelo mañana, ¿tienen horarios disponibles?',
  'Quiero un corte de pelo mañana; ¿qué horas libres tienen?','Me gustaría reservar un corte mañana, ¿a qué hora hay lugar?',
  'Busco una cita para corte mañana. ¿Qué horarios me pueden ofrecer?'];
for(const [language,phrases] of [['en',embeddedEn],['es',embeddedEs]]) phrases.forEach((text,i)=>add('embedded_availability',language,text,
  ['BOOK_REQUEST','SET_SERVICE','SET_DATE','REQUEST_AVAILABILITY'],{service:'Haircut',date:D},
  {real:i===0,label:{expectedDaypart:language==='en'?'AFTERNOON':null,expectedEffects:effects(1)}}));
['Quiero cortarme el pelo este sábado, ¿tienen disponibilidad?',
 'Quisiera un corte este sábado; ¿hay citas libres?','Me quiero cortar el pelo el sábado. ¿Qué disponibilidad tienen?',
 'Necesito reservar un corte de pelo este sábado, ¿hay algún horario?'].forEach((text,i)=>add('embedded_availability','es',text,
  ['BOOK_REQUEST','SET_SERVICE','SET_DATE','REQUEST_AVAILABILITY'],{service:'Haircut',date:D},{real:i===0,label:{expectedEffects:effects(1)}}));
pair('availability_only',[
  'What morning times are available Saturday?','Which Saturday morning openings do you have?','Can you show me Saturday morning availability?','Any free appointments on Saturday morning?'],[
  '¿Qué horario tienen disponible el sábado en la mañana?','¿Qué horas libres tienen el sábado por la mañana?',
  'Para el sábado por la mañana, ¿qué horarios ofrecen?','¿Hay algún horario disponible la mañana del sábado?'],
  ['SET_DATE','REQUEST_AVAILABILITY'],{date:D},{context:'service',label:{expectedDaypart:'MORNING',expectedEffects:effects(1)}});
cases.find(c=>c.turns[0].text==='¿Qué horario tienen disponible el sábado en la mañana?').sourceType='supplied_real_phrase';
pair('facts_order',[
  'Saturday at 3 pm, a haircut please.','At 15:00 tomorrow I would like a haircut.','For a haircut, tomorrow, three in the afternoon.'],[
  'Para mañana a las tres de la tarde, un corte de pelo.','Un corte, a las 15:00, el sábado.','El sábado, corte de pelo, a las 3 pm.'],booking,
  {service:'Haircut',date:D,time:'15:00'},{label:{expectedEffects:effects(1),expectedClarification:true}});
pair('multiple_facts',[
  'My name is Example and I need a haircut Saturday at 3 pm.','A haircut tomorrow at 15:00 under the name Example.','Example here; please book a haircut October 24 at 3 pm.'],[
  'Me llamo Example y quiero un corte mañana a las 3 pm.','Soy Example; un corte de pelo el sábado a las tres de la tarde.','Mi nombre es Example y necesito corte para el 24 de octubre a las 15:00.'],
  [...booking,'SET_NAME'],{service:'Haircut',date:D,time:'15:00',name:'Example'},{label:{expectedEffects:effects(1)}});
const compoundsEn=['Hi, I wanna get a haircut and my beard cut.','I would like a haircut and a beard cut, please.',
  'Could I get a haircut and a beard trim together?','Please put me down for a haircut and beard trim.'];
const compoundsEs=['Hola, quiero hacer cita para un corte de pelo y de barba.','Quisiera un corte de pelo y un recorte de barba.',
  'Necesito una cita para corte y barba, por favor.','Me gustaría cortarme el pelo y hacerme un recorte de barba.'];
for(const [language,phrases]of[['en',compoundsEn],['es',compoundsEs]]) phrases.forEach((text,i)=>add('compound_services',language,text,
  ['BOOK_REQUEST','SET_SERVICE'],{service:'Haircut',additionalServices:['Beard Trim']},{real:i===0,label:{expectedClarification:true}}));
pair('service_correction',[
  'Actually, only the haircut.','Keep the haircut, but no beard trim.','Just the haircut please; forget the beard.','Remove the beard trim and leave the haircut.'],[
  'Mejor solamente el corte de pelo; la barba no.','Solamente el corte de pelo, sin barba.',
  'Quiero dejar solo el corte; quita el recorte de barba.','El corte de pelo sí, pero la barba no.'],['CORRECT_SERVICE'],{additionalServices:[]},{context:'compound',label:{expectedCorrectionTarget:'service'}});
cases.find(c=>c.turns[0].text==='Mejor solamente el corte de pelo; la barba no.').sourceType='supplied_real_phrase';
pair('correction_with_availability',[
  'Switch to Beard Trim; what times are available Saturday?','Actually a beard cut instead, what openings do you have?',
  'Change the service to Beard Trim and show me available times.'],[
  'Mejor un recorte de barba; ¿qué horarios hay el sábado?','Cambia el corte por barba, ¿qué horas tienen libres?',
  'Quiero barba en vez de corte, ¿qué horarios disponibles tienen?'],['CORRECT_SERVICE','REQUEST_AVAILABILITY'],
  {service:'Beard Trim'},{context:'dated',label:{expectedCorrectionTarget:'service',expectedEffects:effects(1)}});
pair('date_correction',[
  'Actually, make it Sunday.','Change the date to October 25.','Not Saturday, the next day please.'],[
  'Mejor para el domingo.','Cambia la fecha al 25 de octubre.','No el sábado; el día siguiente.'],['CORRECT_DATE'],{date:NEXT},{context:'ready',label:{expectedCorrectionTarget:'date',expectedEffects:effects(1)}});
pair('time_correction',[
  'Make it 4 pm instead.','Actually, change the time to 16:00.','Not three; four in the afternoon please.'],[
  'Mejor a las cuatro de la tarde.','Cambia la hora a las 16:00.','No a las tres, a las 4 pm por favor.'],['CORRECT_TIME'],{time:'16:00'},{context:'ready',label:{expectedCorrectionTarget:'time',expectedEffects:effects(1)}});
pair('name_correction',[
  'My name is Sample, not Example.','Actually the name should be Sample.','Please change my name to Sample.'],[
  'Mi nombre es Sample, no Example.','En realidad me llamo Sample.','Cambia el nombre a Sample, por favor.'],['CORRECT_NAME'],{name:'Sample'},{context:'ready',label:{expectedCorrectionTarget:'name'}});
pair('daypart',[
  'Morning times please.','I prefer the afternoon.','What times are available in the afternoon?'],[
  'Por la mañana.','Prefiero por la tarde.','¿Qué horarios tienen en la tarde?'],['REQUEST_AVAILABILITY'],{},
  {context:'dated',label:{expectedDaypart:'AFTERNOON',expectedEffects:effects(1)}});
for(const c of cases.filter(c=>c.category==='daypart')) if(['Morning times please.','Por la mañana.'].includes(c.turns[0].text)){
  c.expectedDaypart='MORNING';c.turns[0].expectedDaypart='MORNING';
}
for(const [language,text,lower,upper]of[
  ['en','Anything after 2 pm?',{time:'14:00',inclusive:false},null],['en','At or after 2 pm, please.',{time:'14:00',inclusive:true},null],
  ['en','Anything before 4 pm?',null,{time:'16:00',inclusive:false}],['en','Do you have anything later?',{time:'16:00',inclusive:false},null],
  ['es','¿Algo después de las 2 pm?',{time:'14:00',inclusive:false},null],['es','A las 2 pm o después.',{time:'14:00',inclusive:true},null],
  ['es','¿Hay algo antes de las 4 pm?',null,{time:'16:00',inclusive:false}],['es','¿Tienen algo más tarde?',{time:'16:00',inclusive:false},null],
]) add('time_bounds',language,text,['REQUEST_AVAILABILITY'],{},{context:'offered',label:{expectedLowerBound:lower,expectedUpperBound:upper,expectedEffects:effects(1)},representationLimit:upper?'upper_bound':null});
const earlyGroups=[['en',['First thing Saturday morning, please.','Saturday as early in the morning as possible.',
  'The earliest morning opening on Saturday please.','Can I get the very first morning slot on Saturday?']],
 ['en',['As early as you open on Saturday.','When you open Saturday, the first slot please.',
  'Right at opening time this Saturday if possible.','The first available appointment when you open Saturday.']],
 ['es',['A primera hora, por favor.','Lo primero de la mañana, por favor.','La primera cita de la mañana, si es posible.','Apenas abran, por favor.']],
 ['es',['Lo más temprano que tengan el sábado.','El primer horario que tengan el sábado.',
  'Quiero ir lo más temprano posible este sábado.','¿Cuál es la primera cita disponible del sábado?']]];
for(const [language,phrases]of earlyGroups) phrases.forEach((text,i)=>add('early_opening',language,text,['REQUEST_AVAILABILITY','EARLIEST_AVAILABLE'],{},
  {context:'dated',real:i===0,label:{expectedDaypart:'MORNING',expectedEffects:effects(1)},representationLimit:'earliest_available'}));
pair('alternative_selection',['The second one, please.','I will take the 3 pm option.','Number two works for me.'],
  ['La segunda, por favor.','Me quedo con la opción de las 3 pm.','El segundo horario me sirve.'],['SELECT_ALTERNATIVE','SET_TIME'],{time:'15:00'},
  {context:'offered',label:{expectedEffects:effects(1)}});
pair('alternative_rejection',['None of those times works.','I cannot make any of those options.','Those are all too late for me.'],
  ['Ninguno de esos horarios me sirve.','No puedo en ninguna de esas opciones.','Todos esos horarios son demasiado tarde.'],
  ['REJECT_ALTERNATIVES'],{},{context:'offered',label:{expectedClarification:true},representationLimit:'reject_alternatives'});
for(const c of cases.filter(c=>c.category==='alternative_rejection'&&['Those are all too late for me.','Todos esos horarios son demasiado tarde.'].includes(c.turns[0].text))){
  for(const label of [c,c.turns[0]]) Object.assign(label,{expectedIntents:['REJECT_ALTERNATIVES','REQUEST_AVAILABILITY'],
    expectedUpperBound:{time:'14:00',inclusive:false},expectedClarification:false,expectedEffects:effects(1)});
}
for(const [language,phrases]of[['en',['Yes','Yes please.','That is right, go ahead.','Absolutely, book it.']],['es',['Sí','Sí, por favor.','Correcto, adelante.','Así es, resérvala.']]])
 phrases.forEach((text,i)=>add('affirmative',language,text,['AFFIRM_CONFIRMATION'],{},
  {context:'ready',real:i===0,label:{expectedConfirmation:'affirm',expectedEffects:effects(0,1,1)}}));
pair('denial',['No.','No thanks, do not book it.','That is not right.'],['No.','No gracias, no la reserves.','Eso no es correcto.'],
  ['DENY_CONFIRMATION'],{},{context:'ready',label:{expectedConfirmation:'deny'}});
pair('uncertain_consent',['Maybe, I am not sure.','I guess... actually wait.','Mmm?'],['Tal vez, no estoy seguro.','Supongo... espera.','Eh... no sé.'],
  ['UNCERTAIN'],{},{context:'ready',label:{expectedConfirmation:'unknown',expectedClarification:true,ambiguityReason:'No definite consent or denial was supplied.'}});
pair('confirmation_question',['Is that on Saturday?','Does that include the beard trim?','How much will that cost?'],
  ['¿Eso es para el sábado?','¿Eso incluye el recorte de barba?','¿Cuánto va a costar?'],['QUESTION_ABOUT_CONFIRMATION'],{},
  {context:'ready',representationLimit:'question_during_confirmation'});
for(const [language,phrases]of[['en',['Do you have time for a question?','Can I ask you something?','May I ask a quick question?','Are you free to answer a question?']],
 ['es',['¿Tienes tiempo para una pregunta?','¿Puedo hacerte una pregunta?','¿Me respondes una pregunta rápida?','¿Tienes un momento para una consulta?']]])
 phrases.forEach((text,i)=>add('unrelated_question',language,text,['UNRELATED_QUESTION'],{}, {context:'dated',real:language==='es'&&i===0,representationLimit:'unrelated_question'}));
pair('informal_filler',['Um, I need a haircut tomorrow at 3 pm.','Hey, a haircut Saturday at three in the afternoon, please.','Uh, can I book a haircut October 24 at 15:00?'],
 ['Eh, necesito un corte mañana a las 3 pm.','Pues un corte de pelo el sábado a las tres de la tarde.','Este... quiero reservar un corte el 24 de octubre a las 15:00.'],
 booking,{service:'Haircut',date:D,time:'15:00'},{tags:['filler_noise'],label:{expectedEffects:effects(1),expectedClarification:true}});
pair('pause_fragment',['A haircut... tomorrow... at 3 pm.','I would like... a haircut, Saturday, three pm.','Haircut, um... October 24... 15:00.'],
 ['Un corte... mañana... a las 3 pm.','Quiero... un corte de pelo, el sábado, a las tres de la tarde.','Corte de pelo... el 24 de octubre... 15:00.'],
 booking,{service:'Haircut',date:D,time:'15:00'},{tags:['filler_noise','pause'],label:{expectedEffects:effects(1),expectedClarification:true}});
pair('background_fragment',['[background television] ten minutes remaining','[background conversation] yes, yes','[noise, unintelligible speech]'],
 ['[televisión de fondo] quedan diez minutos','[conversación de fondo] sí, sí','[ruido, voz ininteligible]'],['IGNORE_BACKGROUND'],{},
  {context:'dated',tags:['filler_noise','background'],label:{expectedClarification:true,ambiguityReason:'Speaker identity and intelligibility cannot be established from a text-only fragment.'}});
pair('language_mismatch',['I need a haircut tomorrow at 3 pm.','Can I book a beard trim Saturday at 15:00?','I want un corte para mañana at 3 pm.'],
 ['Necesito un corte mañana a las tres de la tarde.','Quiero reservar Beard Trim el sábado a las 3 pm.','Necesito un haircut tomorrow a las 3 pm.'],
 booking,{service:'Haircut',date:D,time:'15:00'},{tags:['mixed_language'],label:{expectedEffects:effects(1),expectedClarification:true}});
for(const c of cases.filter(c=>c.category==='language_mismatch')) {
  c.businessLanguage=c.language==='en'?'es':'en';c.transcriptionLanguage=c.businessLanguage;
  if(c.turns[0].text.includes('beard trim')||c.turns[0].text.includes('Beard Trim')){
    c.expectedServicesInMentionOrder=['Beard Trim']; c.turns[0].expectedServicesInMentionOrder=['Beard Trim'];
  }
}
pair('transcription_artifact',['kes','[inaudible]','y... [cut off]'],['kes','[ininteligible]','s... [se corta]'],['UNCERTAIN'],{},
  {context:'ready',tags:['filler_noise','artifact'],label:{expectedConfirmation:'unknown',expectedClarification:true,ambiguityReason:'No reliable affirmative can be recovered from this artifact.'}});
pair('non_time_numbers',['I have two questions.','My bus is number fifteen.','There are three people with me.'],
 ['Tengo una pregunta.','Mi autobús es el número quince.','Somos tres personas.'],['UNRELATED_INFORMATION'],{},
  {context:'dated',representationLimit:'unrelated_information'});
pair('repeated_information',['A haircut, yes, the same haircut.','Saturday, the same date we said.','Still 3 pm, no change.'],
 ['Corte de pelo, el mismo corte.','El sábado, la misma fecha.','Sigo con las 3 pm, sin cambios.'],['REPEAT_INFORMATION'],{}, {context:'ready'});
for(const [language,text,patch,intents]of[
 ['en','Can I book an appointment?',{},['BOOK_REQUEST']],['en','A haircut please.',{service:'Haircut'},['SET_SERVICE']],
 ['en','Tomorrow at 3 pm, please.',{date:D,time:'15:00'},['BOOK_REQUEST','SET_DATE','SET_TIME']],
 ['es','Quiero hacer una cita.',{},['BOOK_REQUEST']],['es','Un corte, por favor.',{service:'Haircut'},['SET_SERVICE']],
 ['es','Mañana a las 3 pm, por favor.',{date:D,time:'15:00'},['BOOK_REQUEST','SET_DATE','SET_TIME']],
])add('missing_information',language,text,intents,patch,{label:{expectedClarification:true}});

// Forty hand-labeled dialogue paths: ten stateful themes, two wordings, both languages.
function dialogue(language,theme,variation,context,steps) {
  const start=structuredClone(contexts[context]);let state=structuredClone(start);
  const id=`dialogue-${theme}-${language}-${variation}`;
  const turns=steps.map(([text,intents,patch={},label={},metadata={}],index)=>{
    state={...state,...patch};return{itemId:`${id}:${index+1}`,text,...expected(state,intents,label),...metadata};
  });
  const last=turns.at(-1);
  cases.push({id,language,category:`dialogue_${theme}`,sourceType:'synthetic',referenceDate:'2026-10-23',timezone:'America/New_York',
    businessLanguage:variation===1?(language==='en'?'es':'en'):language,transcriptionLanguage:variation===1?(language==='en'?'es':'en'):language,
    serviceCatalogue:catalogue,businessHours:hours,initialProposal:start,
    currentRequirement:context==='empty'?'NEEDS_SERVICE':context==='selected'?'NEEDS_NAME':'NEEDS_CONFIRMATION',
    lastResponsePurpose:context==='ready'?'PRE_BOOKING_CONFIRMATION':context==='selected'?'ASK_NAME':'ASK_SERVICE',alternatives:[],turns,
    ...Object.fromEntries(Object.entries(last).filter(([key])=>key.startsWith('expected')||key==='ambiguityReason')),
    tags:theme==='language_switch'?['mixed_language']:theme==='paused'||theme==='delayed'?['pause','filler_noise']:[],representationLimit:null});
}
for(const language of ['en','es'])for(const variation of [1,2]){
 const es=language==='es', yes=es?'Sí, por favor.':'Yes please.', name=es?'Mi nombre es Example.':'My name is Example.';
 const service=es?(variation===1?'Un corte de pelo, por favor.':'Necesito cortarme el pelo.'):(variation===1?'A haircut please.':'I need a haircut.');
 const date=es?(variation===1?'Para el sábado, por favor.':'Mañana, por favor.'):(variation===1?'Saturday, please.':'Tomorrow please.');
 const time=es?(variation===1?'A las 3 pm.':'A las tres de la tarde.'):(variation===1?'3 pm please.':'Three in the afternoon.');
 const tail=[[time,['SET_TIME'],{time:'15:00'},{expectedEffects:effects(1),expectedClarification:true}],
  [name,['SET_NAME'],{name:'Example'}],[yes,['AFFIRM_CONFIRMATION'],{},{expectedConfirmation:'affirm',expectedEffects:effects(0,1,1)}]];
 dialogue(language,'service_date',variation,'empty',[[service,['SET_SERVICE'],{service:'Haircut'},{expectedClarification:true}],
  [date,['SET_DATE'],{date:D},{expectedClarification:true}],...tail]);
 dialogue(language,'date_service',variation,'empty',[[date,['SET_DATE'],{date:D},{expectedClarification:true}],
  [service,['SET_SERVICE'],{service:'Haircut'},{expectedClarification:true}],...tail]);
 dialogue(language,'availability_selection',variation,'empty',[
  [es?'Quiero un corte mañana; ¿qué horarios tienen?':'I need a haircut tomorrow; what times are available?',
   ['BOOK_REQUEST','SET_SERVICE','SET_DATE','REQUEST_AVAILABILITY'],{service:'Haircut',date:D},{expectedEffects:effects(1)}],
  [es?'El segundo horario, por favor.':'The second option please.',['SELECT_ALTERNATIVE','SET_TIME'],{time:'15:00'},{expectedEffects:effects(1),expectedClarification:true}],
  [name,['SET_NAME'],{name:'Example'}],[yes,['AFFIRM_CONFIRMATION'],{},{expectedConfirmation:'affirm',expectedEffects:effects(0,1,1)}]]);
 dialogue(language,'name_correction',variation,'selected',[[name,['SET_NAME'],{name:'Example'}],
  [es?'En realidad mi nombre es Sample.':'Actually, my name is Sample.',['CORRECT_NAME'],{name:'Sample'},{expectedCorrectionTarget:'name'}],
  [yes,['AFFIRM_CONFIRMATION'],{},{expectedConfirmation:'affirm',expectedEffects:effects(0,1,1)}]]);
 dialogue(language,'confirmation_affirm',variation,'ready',[
  [es?'Repítame los detalles, por favor.':'Please repeat the appointment details.',['QUESTION_ABOUT_CONFIRMATION'],{}],
  [yes,['AFFIRM_CONFIRMATION'],{},{expectedConfirmation:'affirm',expectedEffects:effects(0,1,1)}]]);
 dialogue(language,'confirmation_deny',variation,'ready',[
  [es?'No, así no.':'No, that is not right.',['DENY_CONFIRMATION'],{},{expectedConfirmation:'deny'}],
  [es?'Mejor a las 4 pm.':'Make it 4 pm instead.',['CORRECT_TIME'],{time:'16:00'},{expectedCorrectionTarget:'time',expectedEffects:effects(1)}]]);
 dialogue(language,'confirmation_question',variation,'ready',[
  [es?'¿Cuánto cuesta?':'How much does that cost?',['QUESTION_ABOUT_CONFIRMATION'],{}],
  [es?'No, no la reserves.':'No, do not book it.',['DENY_CONFIRMATION'],{},{expectedConfirmation:'deny'}]]);
 dialogue(language,'compound_removal',variation,'empty',[
  [es?'Quiero un corte de pelo y barba.':'I need a haircut and a beard trim.',['BOOK_REQUEST','SET_SERVICE'],{service:'Haircut',additionalServices:['Beard Trim']},{expectedClarification:true}],
  [es?'Mejor solamente el corte de pelo; la barba no.':'Actually, only the haircut.',['CORRECT_SERVICE'],{additionalServices:[]},{expectedCorrectionTarget:'service',expectedClarification:true}],
  [date,['SET_DATE'],{date:D},{expectedClarification:true}],...tail]);
 dialogue(language,'language_switch',variation,'empty',[
  [service,['SET_SERVICE'],{service:'Haircut'},{expectedClarification:true}],
  [es?'Tomorrow, please.':'Mañana, por favor.',['SET_DATE'],{date:D},{expectedClarification:true}],...tail]);
 const repeatedId=`dialogue-paused-${language}-${variation}:1`;
 dialogue(language,'paused',variation,'empty',[
  [service,['SET_SERVICE'],{service:'Haircut'},{expectedClarification:true},{holdResponse:true}],
  [date,['SET_DATE'],{date:D},{expectedClarification:true},{speechDuringPreparation:true}],
  [service,[],{},{expectedClarification:false},{itemId:repeatedId}],...tail]);
}
const placeholders=[...Array.from({length:25},(_,i)=>({id:`owner-single-${i+1}`,sourceType:'supplied_real_phrase',populated:false,turns:[],ownerInstructions:'Supply anonymized phrase and independently label intended meaning before evaluation.'})),
 ...Array.from({length:8},(_,i)=>({id:`owner-dialogue-${i+1}`,sourceType:'supplied_real_phrase',populated:false,turns:[],ownerInstructions:'Supply anonymized dialogue and expected outcome after every turn.'}))];
mkdirSync(directory,{recursive:true});
const text=JSON.stringify(cases,null,2)+'\n';writeFileSync(new URL('cases.json',directory),text);
writeFileSync(new URL('owner-placeholders.json',directory),JSON.stringify(placeholders,null,2)+'\n');
writeFileSync(new URL('labels.sha256',directory),createHash('sha256').update(text).digest('hex')+'  cases.json\n');
console.log(JSON.stringify({populated:cases.length,single:cases.filter(c=>c.turns.length===1).length,dialogues:cases.filter(c=>c.turns.length>1).length,
 languages:Object.fromEntries(['en','es'].map(l=>[l,cases.filter(c=>c.language===l).length])),labelsSha256:createHash('sha256').update(text).digest('hex')}));
