export function createVerifyTransport(options={}) {
  if(options.enabled!==true)return Object.freeze({enabled:false});
  const {http,accountSid,authToken,serviceSid}=options;
  if(typeof http!=='function'||!/^AC[a-f0-9]{32}$/i.test(accountSid)||!/^VA[a-f0-9]{32}$/i.test(serviceSid)||typeof authToken!=='string'||!authToken||/[\r\n]/.test(authToken))throw Error('VERIFY_CONFIGURATION_INVALID');
  const request=async(path,form,controls={})=>{
    let response;try{response=await http(`https://verify.twilio.com/v2/Services/${serviceSid}/${path}`,{method:'POST',headers:{authorization:`Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form).toString(),signal:controls.signal?AbortSignal.any([AbortSignal.timeout(10000),controls.signal]):AbortSignal.timeout(10000)});}catch{throw Error('VERIFY_SUBMISSION_UNKNOWN');}
    if(!response.ok)throw Error('VERIFY_PROVIDER_REJECTED');
    let body;try{body=await response.json();}catch{throw Error('VERIFY_INVALID_RESPONSE');}
    if(!/^VE[a-f0-9]{32}$/i.test(body?.sid)||body.service_sid!==serviceSid||!['pending','approved'].includes(body.status))throw Error('VERIFY_INVALID_RESPONSE');
    return {id:body.sid,status:body.status};
  };
  return Object.freeze({enabled:true,start:(phone,controls)=>request('Verifications',{To:phone,Channel:'sms'},controls),check:(verificationId,code,controls)=>request('VerificationCheck',{VerificationSid:verificationId,Code:code},controls)});
}
