import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const REGISTRY=JSON.parse(await readFile('config/hotels.json','utf8'));
const HAPPY_REFS=REGISTRY.filter(h=>h.enabled&&(h.kind==='happyhotel'||(h.kind==='pending'&&h.phoneSource?.includes('happyhotel.jp/hotels/'))))
  .map(h=>({...h,remoteId:h.happyHotelId||h.phoneSource.match(/hotels\/(\d+)/)?.[1]})).filter(h=>h.remoteId);
const HOTENAVI_REFS=REGISTRY.filter(h=>h.enabled&&h.kind==='hotenavi').map(h=>({...h,sourceUrl:h.url}));
const EXTRA_HOTENAVI=REGISTRY.filter(h=>h.enabled&&h.hotelId==='H013').map(h=>({...h,sourceUrl:'https://www.hotenavi.com/rape/empty/'}));
const BASE='https://happyhotel.jp';
const SYNC='https://hotelsearchman.2123essence.workers.dev/api/github-sync';
const CACHE='.session/happyhotel.enc';
const LOGIN_ID=process.env.HH_LOGIN_ID;
const PASSWORD=process.env.HH_PASSWORD;
if(!LOGIN_ID||!PASSWORD)throw Error('HH_LOGIN_ID and HH_PASSWORD repository secrets required');

const SESSION_CACHE_KEY = process.env.SESSION_CACHE_KEY;
if(!SESSION_CACHE_KEY || SESSION_CACHE_KEY.length<32)throw Error('SESSION_CACHE_KEY must be a separate random secret of at least 32 characters');
function derive(salt) { return scryptSync(SESSION_CACHE_KEY,salt,32); }
async function restore() {
  try {
    const o=JSON.parse(await readFile(CACHE,'utf8'));
    const key=derive(Buffer.from(o.salt,'base64'));
    const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(o.iv,'base64'));
    decipher.setAuthTag(Buffer.from(o.tag,'base64'));
    const plaintext=Buffer.concat([decipher.update(Buffer.from(o.body,'base64')),decipher.final()]);
    const value=JSON.parse(plaintext.toString('utf8'));
    if(!Array.isArray(value.cookies))return {cookies:[],loginAt:null};
    console.log('Session: restored encrypted cookie cache');
    return {cookies:value.cookies,loginAt:value.loginAt||null};
  }catch{console.log('Session: no usable encrypted cookie cache');return {cookies:[],loginAt:null};}
}
async function persist(cookies,loginAt) {
  const salt=randomBytes(16),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',derive(salt),iv);
  const payload=Buffer.from(JSON.stringify({cookies,loginAt,storedAt:Date.now()}),'utf8');
  const body=Buffer.concat([cipher.update(payload),cipher.final()]);
  await mkdir('.session',{recursive:true});
  await writeFile(CACHE,JSON.stringify({version:1,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),body:body.toString('base64')}),{mode:0o600});
  console.log('Session: encrypted cache prepared');
}
function normalize(c) {
  const domain=String(c.domain||'').toLowerCase().replace(/^\./,'');
  if(!['happyhotel.jp','api-proxy.happyhotel.jp','ssl.happyhotel.jp'].includes(domain))return null;
  return {name:c.name,value:c.value,domain,path:c.path||'/',hostOnly:c.hostOnly===true,
    expires:c.expires!=null&&c.expires>0?Number(c.expires):null};
}
class CookieHTTP {
  constructor(cookies=[]) {this.cookies=cookies.map(normalize).filter(Boolean);}
  header(url) {
    const u=new URL(url),now=Date.now();
    return this.cookies.filter(c=>(!c.expires||c.expires>now)&&
      (u.hostname===c.domain||(!c.hostOnly&&u.hostname.endsWith('.'+c.domain)))&&
      (u.pathname===c.path||u.pathname.startsWith(c.path.endsWith('/')?c.path:c.path+'/')))
      .map(c=>c.name+'='+c.value).join('; ');
  }
  accept(headers,url) {
    for(const line of headers.getSetCookie?.()||[]) {
      const p=line.split(';').map(x=>x.trim()),i=p[0].indexOf('=');
      if(i<=0)continue;
      const name=p[0].slice(0,i),value=p[0].slice(i+1);
      if(!/^[a-zA-Z0-9_-]+$/.test(name)||/[\x00-\x20;,]/.test(value))continue;
      const obj={name,value,domain:new URL(url).hostname,path:'/',hostOnly:true,expires:null};
      for(const part of p.slice(1)) {
        const n=part.indexOf('='),key=(n<0?part:part.slice(0,n)).toLowerCase(),v=part.slice(n+1);
        if(key==='domain'){obj.domain=v.replace(/^\./,'').toLowerCase();obj.hostOnly=false;}
        if(key==='path'&&v.startsWith('/'))obj.path=v;
        if(key==='max-age'&&Number.isFinite(Number(v)))obj.expires=Date.now()+Number(v)*1000;
        if(key==='expires'&&obj.expires===null){const d=Date.parse(v);if(Number.isFinite(d))obj.expires=d;}
      }
      const normalized=normalize(obj);if(!normalized)continue;
      this.cookies=this.cookies.filter(c=>!(c.name===name&&c.domain===normalized.domain&&c.path===normalized.path));
      if(!normalized.expires||normalized.expires>Date.now())this.cookies.push(normalized);
    }
  }
  async request(url,opts={}) {
    let current=url,method=opts.method||'GET',body=opts.body;
    for(let hops=0;hops<6;hops++){
      const u=new URL(current);
      if(u.protocol!=='https:'||!['happyhotel.jp','api-proxy.happyhotel.jp','ssl.happyhotel.jp'].includes(u.hostname))
        throw Error('Unexpected redirect domain');
      const headers={accept:'text/html,application/json;q=0.9','accept-language':'ja-JP,ja;q=0.9',...opts.headers};
      if(this.header(current))headers.cookie=this.header(current);
      const r=await fetch(current,{method,body,headers,redirect:'manual',signal:AbortSignal.timeout(15000)});
      this.accept(r.headers,current);
      if(![301,302,303,307,308].includes(r.status))return {status:r.status,url:current,body:await r.text()};
      const location=r.headers.get('location');if(!location)throw Error('Redirect missing location');
      current=new URL(location,current).href;
      if(r.status===303||([301,302].includes(r.status)&&method==='POST')){method='GET';body=undefined;}
    }
    throw Error('Too many redirects');
  }
}
async function checkSession(client) {
  try {
    const r=await client.request('https://api-proxy.happyhotel.jp/v2/User/UserInfo',{
      method:'POST',body:'{}',headers:{accept:'application/json','content-type':'application/json',origin:BASE,referer:BASE+'/my/'}});
    if(r.status!==200)return false;
    const data=JSON.parse(r.body),v=data?.results??data;
    return v?.success!==false&&Number(v?.loginStatus)>0&&Boolean(v?.user_id);
  }catch{return false;}
}
async function browserLogin(){
  console.log('Session: starting browser only to renew login');
  const browser=await chromium.launch({headless:true,channel:'chrome'});
  try{
    const context=await browser.newContext({locale:'ja-JP',timezoneId:'Asia/Tokyo'});
    const page=await context.newPage();
    await page.goto(BASE+'/my/login?srd=%2F',{waitUntil:'domcontentloaded',timeout:30000});
    const form=page.locator('form[action*="mypage_login_check.jsp"]');
    await form.locator('input[name="uid"]').fill(LOGIN_ID);
    await form.locator('input[name="passwd"]').fill(PASSWORD);
    await form.locator('.__decision a').click();
    await page.waitForTimeout(1200);
    const verified=await page.evaluate(async()=>{try{const r=await fetch('https://api-proxy.happyhotel.jp/v2/User/UserInfo',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:'{}'});const v=await r.json(),d=v?.results??v;return r.ok&&d?.success!==false&&Number(d?.loginStatus)>0&&!!d?.user_id;}catch{return false;}});
    if(!verified)throw Error('Browser login did not verify membership');
    const cookies=(await context.cookies()).map(c=>normalize({...c,hostOnly:!c.domain.startsWith('.'),expires:c.expires>0?c.expires*1000:null})).filter(Boolean);
    console.log('Session: browser login verified, cookies saved privately');
    return cookies;
  }finally{await browser.close();}
}
function scan(v,id,records,depth=0) {
  if(!v||typeof v!=='object'||depth>20)return;
  if(Array.isArray(v)){for(const x of v)scan(x,id,records,depth+1);return;}
  if(String(v.hotelId??'')===id&&v.emptyRoom!=null){
    const n=Number(v.emptyRoom),date=String(v.emptyUpDate??v.sourceDate??''),time=String(v.emptyUpTime??v.sourceTime??'').padStart(4,'0');
    if(Number.isSafeInteger(n)&&n>0&&n<=500&&/^[0-9]{8}$/.test(date)&&/^[0-9]{4}$/.test(time)&&+time.slice(0,2)<24&&+time.slice(2)<60)
      records.push({ok:true,hotelId:id,emptyRoom:n,emptyStatus:String(v.emptyStatus??''),sourceDate:date,sourceTime:time});
  }
  for(const x of Object.values(v))scan(x,id,records,depth+1);
}
function parseNext(html,id,records) {
  const m=html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if(m){try{scan(JSON.parse(m[1]),id,records);}catch{}}
}
async function hotelHttp(client,id) {
  const records=[];
  for(const path of ['/reserve/keep/hotels/','/hotels/']) {
    const r=await client.request(BASE+path+id);
    console.log('HTTP hotel',id,r.status);
    if(r.status===200)parseNext(r.body,id,records);
  }
  return records.sort((a,b)=>(b.sourceDate+b.sourceTime).localeCompare(a.sourceDate+a.sourceTime))[0]||null;
}
async function githubToken(){
  const url=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL||'');
  url.searchParams.set('audience',SYNC);
  const r=await fetch(url,{headers:{Authorization:'Bearer '+process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error('OIDC token request HTTP '+r.status);
  return (await r.json()).value;
}
async function sync(results, cookies) {
  const token=await githubToken();
  const payload=process.env.COOKIE_TRANSFER_PROBE==='1'?{results,cookies}:{results};
  const response=await fetch(SYNC,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw Error('Cloudflare sync HTTP '+response.status);
  const json=await response.json();if(!json.ok)throw Error('Cloudflare sync rejected');
  console.log('Cloudflare sync summary:',JSON.stringify(json));
}
const restored=await restore();
let client=new CookieHTTP(restored.cookies);
let sessionStart=restored.loginAt||null;
let verified=await checkSession(client);
const ageMinutes=sessionStart?Math.round((Date.now()-sessionStart)/60000):null;
console.log('Session status:',JSON.stringify({authenticated:verified,sessionAgeMinutes:ageMinutes}));
if(!verified){
  client=new CookieHTTP(await browserLogin());
  sessionStart=Date.now();
  console.log('Session renewed:',JSON.stringify({previousAgeMinutes:ageMinutes,at:new Date(sessionStart).toISOString()}));
}
await persist(client.cookies,sessionStart);
let results=[];
for(const hotel of HAPPY_REFS){
  const id=hotel.remoteId;
  try{
    const r=await hotelHttp(client,id);
    results.push(r?{...r,localId:hotel.hotelId,sourceType:'happyhotel'}:{ok:false,hotelId:id,localId:hotel.hotelId});
    console.log('Hotel result:',JSON.stringify(r?{hotelId:id,emptyRoom:r.emptyRoom,sourceDate:r.sourceDate,sourceTime:r.sourceTime,method:'HTTP'}:{hotelId:id,method:'HTTP',error:'no-room-data'}));
  }catch(e){
    console.warn('Hotel HTTP failed:',id,String(e?.name||'Error'));
    results.push({ok:false,hotelId:id,localId:hotel.hotelId});
  }
}
function sourceText(html) {
 return String(html).replace(/<!--[\s\S]*?-->/g,' ')
  .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<[^>]+>/g,' ')
  .replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&')
  .replace(/[０-９]/g,c=>String(c.charCodeAt(0)-0xff10)).replace(/\s+/g,' ').trim();
}
async function hotenaviHttp(hotel) {
 const url=new URL(hotel.sourceUrl.replace(/\/$/,'')+'/');
 if(url.hostname!=='www.hotenavi.com'||url.protocol!=='https:')throw Error('Unapproved Hotenavi URL');
 const res=await fetch(url,{headers:{'accept':'text/html','accept-language':'ja-JP,ja;q=0.9'},signal:AbortSignal.timeout(14000)});
 if(!res.ok||new URL(res.url).hostname!=='www.hotenavi.com')throw Error('Hotenavi HTTP '+res.status);
 const text=sourceText(await res.text());
 const room=text.match(/空室\s*([0-9]+)\s*室\s*(以上)?/);
 const cleaning=text.match(/準備中\s*([0-9]+)\s*室\s*(以上)?/);
 const when=text.match(/(20\d{2})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})\s*現在/);
 if(!room||!when)return null;
 const time=Date.UTC(+when[1],+when[2]-1,+when[3],+when[4]-9,+when[5]);
 if(!Number.isFinite(time)||time>Date.now()+300000||Date.now()-time>7200000)return null;
 const n=Number(room[1]);if(!Number.isSafeInteger(n)||n>500)return null;
 return {ok:true,localId:hotel.hotelId,sourceType:'hotenavi',emptyRoom:n,
  vacancyAtLeast:!!room[2],cleaning:cleaning?Number(cleaning[1]):null,
  cleaningAtLeast:!!cleaning?.[2],sourceUpdatedAt:new Date(time).toISOString(),sourceUrl:url.href};
}
for(const hotel of [...HOTENAVI_REFS,...EXTRA_HOTENAVI]){
 try{
  const data=await hotenaviHttp(hotel);
  results.push(data||{ok:false,localId:hotel.hotelId,sourceType:'hotenavi'});
  console.log('Hotenavi result:',JSON.stringify(data?{id:hotel.hotelId,rooms:data.emptyRoom,date:data.sourceUpdatedAt}:{id:hotel.hotelId,error:'unavailable'}));
 }catch(e){
  results.push({ok:false,localId:hotel.hotelId,sourceType:'hotenavi'});
  console.warn('Hotenavi unavailable:',hotel.hotelId,String(e?.message||'Error').slice(0,55));
 }
}
console.log('Total registry:',REGISTRY.length,'checked:',results.length,'valid:',results.filter(x=>x.ok).length);
await sync(results,client.cookies);
const requiredIds=new Set(REGISTRY.filter(h=>h.enabled&&h.kind!=='pending').map(h=>h.hotelId));
const requiredFailures=results.filter(x=>requiredIds.has(x.localId)&&!x.ok);
console.log('Validated coverage:',JSON.stringify({listed:REGISTRY.length,available:results.filter(x=>x.ok).length,
  pendingUnavailable:results.filter(x=>!x.ok&&!requiredIds.has(x.localId)).map(x=>x.localId),
  requiredFailures:requiredFailures.map(x=>x.localId)}));
if(requiredFailures.length){console.error('One or more configured active sources failed');process.exitCode=1;}
