// Read-only readiness: never creates, drops or reconciles indexes.
export async function verifyDeclaredIndexes(models,{ttlAllowed=[]}={}){
 for(const M of Object.values(models)){
  const actual=await M.collection.indexes();
  if(!actual.some(i=>i.name==='_id_'&&JSON.stringify(i.key)==='{"_id":1}'))throw Error('INDEX_REQUIRED');
  for(const [key,options]of M.schema.indexes()){
   if(!actual.some(i=>JSON.stringify(i.key)===JSON.stringify(key)&&!!i.unique===!!options.unique&&!!i.sparse===!!options.sparse&&JSON.stringify(i.partialFilterExpression||null)===JSON.stringify(options.partialFilterExpression||null)&&i.expireAfterSeconds===options.expireAfterSeconds))throw Error('INDEX_REQUIRED');
  }
  if(!ttlAllowed.includes(M.modelName)&&actual.some(i=>i.expireAfterSeconds!==undefined))throw Error('DURABLE_INDEX_INCOMPATIBLE');
 }
 return true;
}
