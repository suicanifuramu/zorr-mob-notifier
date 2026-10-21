// Manual refresh from the audited research snapshot. The normal Pages build
// consumes the generated data/ and public/assets/; it never executes game code.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';

const root = new URL('../', import.meta.url);
const research = new URL('../research/', import.meta.url);
const game = JSON.parse(await readFile(new URL('extracted-game.json', research)));
const dropData = JSON.parse(await readFile(new URL('mob-drops.json', research)));
const variantData = JSON.parse(await readFile(new URL('variant-drops.json', research)));
const source = await readFile(new URL('zorr-deobfuscator/deobfuscated/1K580MS96-deobfuscated.js', research), 'utf8');
const runtime = await readFile(new URL('extracted-runtime.js', research), 'utf8');
const variantBlock = source.match(/var I = N\(\{([\s\S]*?)\}\);/);
if (!variantBlock) throw new Error('Variant enumeration changed');
const names = [...variantBlock[1].matchAll(/(\w+):\s*1/g)].map(m => m[1]);
if (names.length !== 18) throw new Error('Expected 18 audited variants');
const paletteBlock = source.match(/const jS = (\{[\s\S]*?\n\s*\});/);
if (!paletteBlock) throw new Error('Variant color table changed');
const palette = vm.runInNewContext(`(${paletteBlock[1]})`, { I:Object.fromEntries(names.map(n => [n,n])) }, { timeout:1000 });
const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const catalog = {
  schemaVersion:1,
  source:{ script:'https://zorr.pages.dev/1K580MS96.js', sha256:dropData.identity.sha256, snapshotDate:'2026-10-21' },
  rendering:{ font:game.rendering.font, cellSize:128, mobColumns:14, petalColumns:20 },
  rarities:dropData.rarities.map(r => ({...r,slug:slug(r.name)})),
  variants:names.map((name,id) => ({ id,name,slug:slug(name),color:palette[name] ? `hsl(${palette[name][0]} ${palette[name][1]}% 65%)` : ({Magic:'#29e9ef',Arcane:'#ff9242',Cursed:'#a0a0a0',Shiny:'#ffe68c',Corrupt:'#b38bd8',Radiant:'#9a8bff'}[name] || '#edf3ef') })),
  petals:game.petals.map(p => ({ id:p.id,name:p.name,slug:p.slug,pet:!!p.pet,magicPetal:p.magicPetal?.slug || null })),
  mobs:dropData.mobs.map(m => ({ id:m.id,name:m.name,slug:m.slug,drops:m.drops.filter(d => d.resolved).map(d => [d.petal,d.effectiveParameter]) })),
  variantDrops:Object.fromEntries(variantData.variants.map(v => [slug(v.variant),v.drops.map(d => [d.petal,d.effectiveParameter])])),
  flashDrops:[['fractal',0.1],['lithium',0.2],['usain_bolt',0.2],['hel_lightning',0.2],['lightning',0.3]],
};
// Flash has a weighted extra candidate, so the filter uses the set of possibilities.
catalog.variantDrops.flash = [['ticket',0.005],...catalog.flashDrops];
await mkdir(new URL('data/',root),{recursive:true});
await mkdir(new URL('public/assets/',root),{recursive:true});
await writeFile(new URL('data/catalog.json',root),JSON.stringify(catalog));
const fontCSS = new URL('https://fonts.googleapis.com/css2');
fontCSS.searchParams.set('family',game.rendering.font);
fontCSS.searchParams.set('text',String.fromCharCode(...Array.from({length:95},(_,i)=>i+32))+'–…');
const response = await fetch(fontCSS,{signal:AbortSignal.timeout(30000)});
if(!response.ok)throw new Error(`Font stylesheet: ${response.status}`);
const fontURL=(await response.text()).match(/src:\s*url\(([^)]+)\)/)?.[1];
if(!fontURL)throw new Error('Font URL missing');
const fontResponse=await fetch(fontURL,{signal:AbortSignal.timeout(30000)});
if(!fontResponse.ok)throw new Error(`Font: ${fontResponse.status}`);
const font=Buffer.from(await fontResponse.arrayBuffer());
await writeFile(new URL('public/assets/fredoka-one.ttf',root),font);
const fontLicenseURL='https://raw.githubusercontent.com/google/fonts/be2838a23fd2918408e22b25c54135da76525ff6/ofl/fredokaone/OFL.txt';
const licenseResponse=await fetch(fontLicenseURL,{signal:AbortSignal.timeout(30000)});
if(!licenseResponse.ok)throw new Error(`Font license: ${licenseResponse.status}`);
await mkdir(new URL('public/licenses/',root),{recursive:true});
await writeFile(new URL('public/licenses/Fredoka-One-OFL.txt',root),await licenseResponse.text());
const browser=await playwright.launch({executablePath:await chromium.executablePath(),args:chromium.args,headless:true});
try {
  const page=await browser.newPage();
  await page.evaluate(async({runtime,font})=>{
    window.IS_PROD=true;globalThis.timeElapsed=0;
    CanvasRenderingContext2D.prototype.As=function(s){this.scale(s,s)};
    new Function(runtime)();
    const face=new FontFace('Fredoka One',`url(data:font/ttf;base64,${font})`);
    await face.load();document.fonts.add(face);
  },{runtime,font:font.toString('base64')});
  for(const [kind,columns] of [['mob',catalog.rendering.mobColumns],['petal',catalog.rendering.petalColumns]]){
    const png=await page.evaluate(({kind,columns})=>{
      const list=kind==='mob'?result.mobs:result.petals;
      const sheet=document.createElement('canvas');sheet.width=columns*128;sheet.height=Math.ceil(list.length/columns)*128;
      const out=sheet.getContext('2d'),cell=document.createElement('canvas');cell.width=cell.height=128;
      const ctx=cell.getContext('2d');
      for(const p of list){
        cell.width=128;ctx.save();ctx.beginPath();ctx.rect(0,0,128,128);ctx.clip();
        if(kind==='mob'){ctx.scale(128,128);result.mobDraw(ctx,p)}
        else{ctx.scale(128/80,128/80);result.draw(ctx,p,0);result.label(ctx,p)}
        ctx.restore();out.drawImage(cell,(p.id%columns)*128,Math.floor(p.id/columns)*128);
      }
      return sheet.toDataURL('image/png').split(',')[1];
    },{kind,columns});
    const bytes=Buffer.from(png,'base64');await writeFile(new URL(`public/assets/${kind}-atlas.png`,root),bytes);
    console.log(`${kind}: ${bytes.length} bytes`);
  }
}finally{await browser.close()}
await writeFile(new URL('data/assets-source.json',root),JSON.stringify({source:catalog.source,renderer:'Chromium',fontURL,fontSha256:createHash('sha256').update(font).digest('hex')},null,2));
console.log(`${catalog.mobs.length} mobs, ${catalog.petals.length} petals, ${names.length} variants`);
