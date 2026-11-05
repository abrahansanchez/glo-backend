const scopeBase='https://www.googleapis.com/auth/';
export const GOOGLE_SCOPES={busy:[scopeBase+'calendar.calendarlist.readonly',scopeBase+'calendar.events.freebusy'],read:[scopeBase+'calendar.calendarlist.readonly',scopeBase+'calendar.events.readonly',scopeBase+'calendar.events.freebusy'],export:[scopeBase+'calendar.calendarlist.readonly',scopeBase+'calendar.events',scopeBase+'calendar.events.freebusy']};
export function createGoogleTransport(options={}){
 if(options.enabled!==true)return Object.freeze({enabled:false});
 const {http,clientId,clientSecret,redirectUri}=options;
 if(typeof http!=='function'||typeof clientId!=='string'||!clientId||typeof clientSecret!=='string'||!clientSecret)throw Error('GOOGLE_CONFIGURATION_INVALID');
 const redirect=new URL(redirectUri);if(redirect.protocol!=='https:'||redirect.username||redirect.password||redirect.hash||redirect.search)throw Error('GOOGLE_REDIRECT_INVALID');
 const request=async(url,{method='GET',token,form,json,headers={}}={})=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{
   const response=await http(url,{method,redirect:'error',signal:controller.signal,headers:{...headers,...(token?{authorization:`Bearer ${token}`}:{}) ,...(form?{'content-type':'application/x-www-form-urlencoded'}:json?{'content-type':'application/json'}:{})},...(form?{body:new URLSearchParams(form).toString()}:json?{body:JSON.stringify(json)}:{})});
   let result={};if(response.status!==204){
    if(response.body?.[Symbol.asyncIterator]){const chunks=[];let count=0;for await(const part of response.body){const b=Buffer.from(part);count+=b.length;if(count>2097152){controller.abort();throw Error('GOOGLE_RESPONSE_TOO_LARGE');}chunks.push(b);}const text=Buffer.concat(chunks).toString();result=text?JSON.parse(text):{};}
    else result=await response.json();
   }
   if(!response.ok)throw Object.assign(Error('GOOGLE_REQUEST_REJECTED'),{httpStatus:response.status,retryAfterSeconds:/^\d{1,5}$/.test(response.headers?.get?.('retry-after')||'')?Math.min(3600,Number(response.headers.get('retry-after'))):0,googleCode:['invalid_grant','invalid_client','access_denied'].includes(result?.error)?result.error:'UNKNOWN'});
   return result;
  }catch(e){if(e.httpStatus)throw e;throw Object.assign(Error('GOOGLE_TRANSPORT_UNKNOWN'),{uncertain:true});}finally{clearTimeout(timer);}
 };
 const calendarPath=id=>`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}`;
 return Object.freeze({enabled:true,
  authorizationUrl:({state,challenge,mode})=>{if(!GOOGLE_SCOPES[mode])throw Error('INVALID_GOOGLE_MODE');const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');u.search=new URLSearchParams({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:GOOGLE_SCOPES[mode].join(' '),state,code_challenge:challenge,code_challenge_method:'S256',access_type:'offline',prompt:'consent'}).toString();return u.toString();},
  exchange:(code,verifier)=>request('https://oauth2.googleapis.com/token',{method:'POST',form:{client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code',code,code_verifier:verifier}}),
  refresh:refreshToken=>request('https://oauth2.googleapis.com/token',{method:'POST',form:{client_id:clientId,client_secret:clientSecret,grant_type:'refresh_token',refresh_token:refreshToken}}),
  revoke:token=>request('https://oauth2.googleapis.com/revoke',{method:'POST',form:{token}}),
  listCalendars:(token,pageToken)=>request('https://www.googleapis.com/calendar/v3/users/me/calendarList?'+new URLSearchParams({maxResults:'100',...(pageToken?{pageToken}:{})}),{token}),
  events:(token,id,query)=>request(calendarPath(id)+'/events?'+new URLSearchParams(Object.fromEntries(Object.entries(query).map(([k,v])=>[k,String(v)]))),{token}),
  freeBusy:(token,id,from,to)=>request('https://www.googleapis.com/calendar/v3/freeBusy',{method:'POST',token,json:{timeMin:from,timeMax:to,items:[{id}]}}),
  watch:(token,id,body)=>request(calendarPath(id)+'/events/watch',{method:'POST',token,json:body}),
  stopChannel:(token,body)=>request('https://www.googleapis.com/calendar/v3/channels/stop',{method:'POST',token,json:body}),
  getEvent:(token,id,eventId)=>request(calendarPath(id)+'/events/'+encodeURIComponent(eventId),{token}),
  putEvent:(token,id,eventId,body,etag)=>request(calendarPath(id)+'/events/'+encodeURIComponent(eventId),{method:'PUT',token,json:body,headers:etag?{'if-match':etag}:{}}),
  insertEvent:(token,id,body)=>request(calendarPath(id)+'/events?sendUpdates=none',{method:'POST',token,json:body}),
  deleteEvent:(token,id,eventId,etag)=>request(calendarPath(id)+'/events/'+encodeURIComponent(eventId)+'?sendUpdates=none',{method:'DELETE',token,headers:etag?{'if-match':etag}:{}})
 });
}
