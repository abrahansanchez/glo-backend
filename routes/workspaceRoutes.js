import express from 'express';
import {protect} from '../middleware/authMiddleware.js';
const exact=(a,k)=>a&&typeof a==='object'&&!Array.isArray(a)&&Object.keys(a).sort().join(',')===k.sort().join(',');
export function workspaceRoutes({workspace,invitations,invitationState=invitations?'READY':'DISABLED',authenticate=protect}){
 const router=express.Router();router.use(authenticate);router.use(express.json({limit:'16kb',inflate:false}));
 const run=fn=>async(req,res)=>{try{if(!req.user?._id)throw Object.assign(Error(),{reasonCode:'FORBIDDEN'});res.json({data:await fn(req,String(req.user._id))});}catch(e){const code=typeof e.reasonCode==='string'&&/^[A-Z_]{1,80}$/.test(e.reasonCode)?e.reasonCode:'WORKSPACE_UNAVAILABLE';res.status(code==='FORBIDDEN'?403:409).json({reasonCode:code});}};
 const body=(req,keys)=>{if(!exact(req.body,keys))throw Object.assign(Error(),{reasonCode:'INVALID_ARGUMENTS'});return req.body;};
 router.get('/workspaces',run(async(_r,id)=>({...await workspace.discover(id),invitationState})));
 router.post('/workspaces/select',run((r,id)=>workspace.select(id,body(r,['businessId']).businessId)));
 router.get('/shop/setup',run((_r,id)=>workspace.readiness(id)));
 router.get('/businesses/:businessId/memberships',run((r,id)=>workspace.memberships(id,r.params.businessId,r.query)));
 router.put('/shop/setup',run((r,id)=>workspace.setup(id,r.body)));
 router.post('/businesses/:businessId/membership/leave',run((r,id)=>workspace.leave(id,r.params.businessId,body(r,['expectedRevision']).expectedRevision)));
 if(invitations){
  router.post('/businesses/:businessId/invitations',run((r,id)=>invitations.create(id,r.params.businessId,r.body)));
  router.get('/businesses/:businessId/invitations',run((r,id)=>invitations.list(id,r.params.businessId)));
  router.post('/businesses/:businessId/invitations/:id/revoke',run((r,id)=>{body(r,[]);return invitations.revoke(id,r.params.businessId,r.params.id);}));
  router.post('/businesses/:businessId/invitations/:id/replace',run((r,id)=>{body(r,[]);return invitations.replace(id,r.params.businessId,r.params.id);}));
  router.post('/invitations/preview',run((r,id)=>invitations.preview(id,body(r,['token']).token)));
  router.post('/invitations/verification/start',run((r,id)=>{const b=body(r,['token','verificationConsent']);return invitations.startProof(id,b.token,b.verificationConsent);}));
  router.post('/invitations/accept',run((r,id)=>{body(r,['token','code','acceptance']);return invitations.accept(id,r.body);}));
 }
 if(!invitations){const unavailable=(_r,res)=>res.status(invitationState==='DISABLED'?404:503).json({reasonCode:invitationState==='DISABLED'?'INVITATIONS_DISABLED':'INVITATION_CONFIGURATION_REQUIRED'});router.use('/invitations',unavailable);router.use('/businesses/:businessId/invitations',unavailable);}
 router.use((e,_q,res,_next)=>res.status(e.type==='entity.too.large'?413:400).json({reasonCode:'INVALID_REQUEST'}));return router;
}
export function invitationPage({mobileReturn}){
 const router=express.Router();router.use((_q,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'"});next();});
 router.get('/',(_q,res)=>res.type('html').send('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Gl&#333; staff invitation</title><script src="./open.js" defer></script><h1>Staff invitation / Invitaci&#243;n</h1><p>Sign in or create your account, verify privately, then choose Accept. Opening this link does not join the shop. Inicia sesi&#243;n o crea tu cuenta, verifica en privado y acepta.</p><a id="open">Open Gl&#333; / Abrir Gl&#333;</a><p id="status"></p></html>'));
 router.get('/open.js',(_q,res)=>res.type('application/javascript').send(`'use strict';const token=location.hash.slice(1);history.replaceState(null,'',location.pathname);if(/^[A-Za-z0-9_-]{43}$/.test(token)){document.getElementById('open').href=${JSON.stringify(mobileReturn)}+'#'+token;}else{document.getElementById('status').textContent='Invalid or expired invitation. Ask the owner. / Pide una nueva invitacion.';}`));return router;
}
