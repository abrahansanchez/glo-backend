export function createAppointmentSmsTransport(options={}){
 if(options.enabled!==true)return Object.freeze({enabled:false});
 const {http,accountSid,authToken,fromNumber,callbackBase}=options;
 if(typeof http!=='function'||!/^AC[a-f0-9]{32}$/i.test(accountSid)||typeof authToken!=='string'||!authToken||/[\r\n]/.test(authToken)||!/^\+[1-9]\d{7,14}$/.test(fromNumber))throw Error('NOTIFICATION_PROVIDER_CONFIGURATION_INVALID');
 const callback=new URL(callbackBase);if(callback.protocol!=='https:'||callback.search||callback.hash||callback.username||callback.password)throw Error('NOTIFICATION_CALLBACK_INVALID');
 return Object.freeze({enabled:true,fromNumber,accountSid,async send({to,body,deliveryId}){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try{let response;try{response=await http(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,{method:'POST',redirect:'error',signal:controller.signal,headers:{authorization:`Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({To:to,From:fromNumber,Body:body,StatusCallback:`${callbackBase}/${deliveryId}`}).toString()});}catch{throw Object.assign(Error('SMS_SUBMISSION_UNKNOWN'),{uncertain:true});}
   let data;try{if(response.body?.[Symbol.asyncIterator]){const parts=[];let n=0;for await(const c of response.body){n+=c.length;if(n>65536){controller.abort();throw Error();}parts.push(Buffer.from(c));}data=JSON.parse(Buffer.concat(parts).toString());}else data=await response.json();}catch{throw Object.assign(Error('SMS_SUBMISSION_UNKNOWN'),{uncertain:true});}
   if(!response.ok)throw Object.assign(Error('SMS_PROVIDER_REJECTED'),{uncertain:response.status>=500,retryable:response.status===429,providerCode:Number.isInteger(data.code)&&data.code>=0&&data.code<100000?String(data.code):'UNKNOWN'});
   if(!/^SM[a-f0-9]{32}$/i.test(data.sid)||!['accepted','queued','sending','sent','delivered','failed','undelivered'].includes(data.status))throw Object.assign(Error('SMS_SUBMISSION_UNKNOWN'),{uncertain:true});return {sid:data.sid,status:data.status};
  }finally{clearTimeout(timer);}
 }});
}
