export async function proxy(context, path, {stream=false}={}) {
  const {BOT_API_URL, BOT_API_TOKEN} = context.env;
  const headers = {'Cache-Control':'no-store, no-transform','X-Content-Type-Options':'nosniff'};
  if (!BOT_API_URL || !BOT_API_TOKEN) return Response.json({error:'Bot connection is not configured.'},{status:503,headers});
  let base;
  try {
    base=new URL(BOT_API_URL);
    const local=['127.0.0.1','localhost','[::1]'].includes(base.hostname);
    if (base.protocol!=='https:' && !(local && base.protocol==='http:')) throw new Error('HTTPS required');
    if(base.username || base.password)throw new Error('Credentials in URL');
  } catch {return Response.json({error:'Invalid bot endpoint configuration.'},{status:503,headers})}
  const url=new URL(path,base.origin);
  const incoming=new URL(context.request.url);
  const after=incoming.searchParams.get('after');
  const last=context.request.headers.get('Last-Event-ID');
  if(stream && (after || last)){
    const cursor=last || after;
    if(!/^\d{1,16}$/.test(cursor))return Response.json({error:'Invalid event cursor.'},{status:400,headers});
    url.searchParams.set('after',cursor);
  }
  try {
    const upstream=await fetch(url,{headers:{Authorization:`Bearer ${BOT_API_TOKEN}`,Accept:stream?'text/event-stream':'application/json'},
      signal:context.request.signal,redirect:'manual',cf:{cacheTtl:0,cacheEverything:false}});
    const expected=stream?'text/event-stream':'application/json';
    if(!upstream.ok || !upstream.headers.get('Content-Type')?.includes(expected)){
      console.warn('Bot returned an unexpected response',upstream.status,upstream.headers.get('Content-Type'));
      await upstream.body?.cancel();
      return Response.json({error:'Bot is temporarily unavailable.'},{status:502,headers});
    }
    return new Response(upstream.body,{status:200,headers:{...headers,'Content-Type':`${expected}; charset=utf-8`,...(stream?{'X-Accel-Buffering':'no'}:{})}});
  }catch(error){console.error('Bot proxy fetch failed',error.name,error.message);return Response.json({error:'Could not connect to the bot.'},{status:502,headers})}
}
