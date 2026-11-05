// Server-owned commercial configuration. No amount, price ID or trial is inferred.
export function shopConfiguration(env=process.env){
 const enabled=env.GLO_SHOP_ONBOARDING_ENABLED==='true';
 const priceId=env.GLO_SHOP_STRIPE_PRICE_ID;
 const trial=env.GLO_SHOP_TRIAL_DAYS;
 const configured=enabled&&typeof priceId==='string'&&/^price_[A-Za-z0-9]{1,128}$/.test(priceId)&&
  (trial===undefined||/^(0|[1-9][0-9]{0,2})$/.test(trial)&&Number(trial)<=365);
 return {enabled,configured,priceId:configured?priceId:null,trialDays:configured&&trial!==undefined?Number(trial):null};
}
export function shopEntitlement(barber,subscription,env=process.env,now=new Date()){
 const c=shopConfiguration(env);
 return !!(c.configured&&subscription&&String(subscription.barber)===String(barber._id)&&
  subscription.priceId===c.priceId&&subscription.stripeCustomerId===barber.stripeCustomerId&&
  subscription.stripeSubscriptionId===barber.stripeSubscriptionId&&/^sub_[A-Za-z0-9]+$/.test(subscription.stripeSubscriptionId)&&
  ['active','trialing'].includes(subscription.status)&&subscription.providerVerifiedAt&&
  (subscription.status!=='trialing'||+new Date(subscription.gracePeriodEndsAt)>+now));
}
