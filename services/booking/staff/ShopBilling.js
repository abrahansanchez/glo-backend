import {shopConfiguration} from './ShopPolicy.js';
const fail=code=>Object.assign(Error(code),{reasonCode:code});
// Called only after the existing Stripe signature verifier, never from a client route.
export async function applyShopSubscriptionEvent({event,Barber,Subscription,env=process.env,now=()=>new Date()}){
 const sub=event.data?.object;if(!sub)return false;
 const subscriptionId=event.type.startsWith('invoice.')||event.type.startsWith('checkout.')?sub.subscription:sub.id;
 const existing=typeof subscriptionId==='string'?await Subscription.findOne({stripeSubscriptionId:subscriptionId}).lean():null;
 const businessId=sub.metadata?.barberId||existing?.barber;
 const b=businessId?await Barber.findById(businessId).lean():null;
 if(b?.productType!=='shop'&&sub.metadata?.productType!=='shop')return false;
 // Checkout redirects, checkout completion and invoices alone never grant shop entitlement.
 if(!['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type))return true;
 const c=shopConfiguration(env),configuredPrice=env.GLO_SHOP_STRIPE_PRICE_ID||existing?.priceId;if(!/^price_[A-Za-z0-9]+$/.test(configuredPrice||'')||!b||b.productType!=='shop'||!b.stripeCustomerId||sub.customer!==b.stripeCustomerId||!/^sub_[A-Za-z0-9]+$/.test(sub.id)||!Number.isSafeInteger(event.created))return true;
 const price=sub.items?.data?.[0]?.price?.id||existing?.priceId;if(price!==configuredPrice)return true;
 const originCreated=sub.created||existing?.providerSubscriptionCreated||event.created;
 const status=event.type==='customer.subscription.deleted'?'canceled':['active','trialing','past_due','canceled','incomplete'].includes(sub.status)?sub.status:'incomplete';
 const update={barber:b._id,stripeCustomerId:sub.customer,stripeSubscriptionId:sub.id,priceId:price,status,providerVerifiedAt:now(),providerEventCreated:event.created,providerSubscriptionCreated:originCreated,...(sub.trial_end?{gracePeriodEndsAt:new Date(sub.trial_end*1000)}:{})};
 try{await Subscription.findOneAndUpdate({stripeSubscriptionId:sub.id,$or:[{providerEventCreated:{$lt:event.created}},{providerEventCreated:{$exists:false}}]},{$set:update},{upsert:true,new:true,runValidators:true});}catch(e){if(e.code!==11000)throw e;}
 const settled=await Subscription.findOne({stripeSubscriptionId:sub.id}).lean();if(!settled)return true;
 await Barber.updateOne({_id:b._id,stripeCustomerId:sub.customer,$or:[{stripeSubscriptionId:sub.id,shopBillingEventCreated:{$lte:settled.providerEventCreated}},{shopSubscriptionCreated:{$lt:settled.providerSubscriptionCreated}},{shopSubscriptionCreated:{$exists:false}}]},{$set:{stripeSubscriptionId:sub.id,subscriptionStatus:settled.status,shopBillingEventCreated:settled.providerEventCreated,shopSubscriptionCreated:settled.providerSubscriptionCreated}});return true;
}
export async function shopCheckout({barber,provider,env=process.env,idempotencyKey}){
 const c=shopConfiguration(env);if(!c.configured)throw fail('SHOP_COMMERCIAL_CONFIGURATION_UNAVAILABLE');if(env.GLO_SHOP_BILLING_DISPATCH_ENABLED!=='true')throw fail('SHOP_BILLING_DISPATCH_DISABLED');
 if(typeof idempotencyKey!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(idempotencyKey))throw fail('IDEMPOTENCY_KEY_REQUIRED');
 const url=new URL(env.APP_BASE_URL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw fail('SHOP_COMMERCIAL_CONFIGURATION_UNAVAILABLE');
 // Customer creation is idempotent per account; no subscription readiness is set here.
 let customer=barber.stripeCustomerId;if(!customer){const r=await provider.customers.create({email:barber.email,name:barber.name,metadata:{barberId:String(barber._id)}},{idempotencyKey:`shop-customer-${barber._id}`});customer=r.id;barber.stripeCustomerId=customer;await barber.save();}
 const metadata={barberId:String(barber._id),productType:'shop',priceId:c.priceId};
 const response=await provider.checkout.sessions.create({mode:'subscription',customer,line_items:[{price:c.priceId,quantity:1}],success_url:url.origin+'/stripe/success',cancel_url:url.origin+'/stripe/cancel',metadata,subscription_data:{metadata,...(c.trialDays>0?{trial_period_days:c.trialDays}:{})}},{idempotencyKey:`shop-checkout-${barber._id}-${idempotencyKey}`});
 return {checkoutUrl:response.url,status:'PAYMENT_PENDING',plan:'shop'};
}
