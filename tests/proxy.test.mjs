import {test} from 'node:test';
import assert from 'node:assert/strict';
import {proxy} from '../functions/_lib/proxy.js';

test('Pages proxy keeps credentials server-side and forwards Last-Event-ID',async()=>{
  const original=globalThis.fetch;let request;
  globalThis.fetch=async(url,options)=>{request={url,options};return new Response('event: status\ndata: {}\n\n',{headers:{'Content-Type':'text/event-stream'}})};
  try{
    const response=await proxy({request:new Request('https://notifier.pages.dev/api/stream?after=1',{headers:{'Last-Event-ID':'42'}}),env:{BOT_API_URL:'https://bot.example.com',BOT_API_TOKEN:'secret-test-token'}},'/api/stream',{stream:true});
    assert.equal(request.url.href,'https://bot.example.com/api/stream?after=42');
    assert.equal(request.options.headers.Authorization,'Bearer secret-test-token');
    assert.equal(request.options.redirect,'manual');
    assert.equal(response.status,200);assert.ok(!JSON.stringify([...response.headers]).includes('secret-test-token'));
    assert.match(response.headers.get('Cache-Control'),/no-store/);
  }finally{globalThis.fetch=original}
});
test('unconfigured proxy and invalid backend fail closed without leaking details',async()=>{
  const request=new Request('https://notifier.pages.dev/api/status');
  assert.equal((await proxy({request,env:{}},'/api/status')).status,503);
  assert.equal((await proxy({request,env:{BOT_API_URL:'http://public.example.com',BOT_API_TOKEN:'a'}},'/api/status')).status,503);
});
test('upstream auth/error pages are not streamed to browsers',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response('upstream private diagnostics',{status:401});
  try{const r=await proxy({request:new Request('https://notifier.pages.dev/api/status'),env:{BOT_API_URL:'https://bot.example.com',BOT_API_TOKEN:'x'}},'/api/status');assert.equal(r.status,502);assert.ok(!(await r.text()).includes('private diagnostics'))}finally{globalThis.fetch=original}
});
