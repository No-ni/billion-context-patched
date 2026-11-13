#!/usr/bin/env node
// Run the shipped encoder against a real localhost receiver. No DSH profile,
// model, gateway, or user encoding configuration is read or modified.
// Usage: node scripts/check-outbound-encoding.mjs [path/to/dist/index.js]
// Development only: node scripts/check-outbound-encoding.mjs --block
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";

const here=dirname(fileURLToPath(import.meta.url));
const argument=process.argv[2];
assert(process.argv.length<=3,"expected one candidate path or --block");
const blockOnly=argument==="--block";
const target=resolve(blockOnly?join(here,"..","patches","outbound-encoding.block.js"):argument??join(here,"..","vendor","billion-context","dist","index.js"));
const source=readFileSync(target,"latin1");
const start=source.indexOf("var __biliEncZlib=");
const end=blockOnly?source.length:source.indexOf("async function fetchWithTimeout(",start);
assert(start>=0&&end>start,"cannot find encoder in "+target);
const helper=source.slice(start,end);
assert(helper.includes("function __biliPlaintextHeaders(sourceHeaders,projectedHeaders)"),"candidate does not contain the plaintext recovery API");
assert(!/[^\x00-\x7f]/.test(readFileSync(join(here,"..","patches","outbound-encoding.block.js"),"latin1")),"encoder source must remain ASCII");
assert(!helper.includes('h["content-length"]=String('),"encoder must leave new content-length to fetch");
const build=new Function("require","process","Buffer","Headers",helper+"\nreturn {encode:__biliEncodeOutbound,plaintextHeaders:__biliPlaintextHeaders,sendStats:__biliSendEncStats,ring:__biliEncRing};");

const scratchRoot=resolve(tmpdir());
const scratch=mkdtempSync(join(scratchRoot,"bili-outbound-check-"));
const stateDir=join(scratch,".local","state","billion-context");
const setting=join(stateDir,"upstream-encoding");
const isolatedProcess={env:{...process.env,HOME:scratch,USERPROFILE:scratch,XDG_STATE_HOME:join(scratch,".local","state"),BILI_UPSTREAM_ENCODING_FILE:join(scratch,"no-user-config.json")}};
let settingClock=Date.now();
const fallback=(encoding)=>{
  writeFileSync(setting,encoding+"\n");
  settingClock+=1000;
  const stamp=new Date(settingClock);
  utimesSync(setting,stamp,stamp);
};
const fresh=(encoding="gzip")=>{
  fallback(encoding);
  return build(createRequire(target),isolatedProcess,Buffer,Headers);
};

const pairs=(headers)=>{
  if(headers instanceof Headers)return [...headers.entries()];
  if(Array.isArray(headers))return headers.map(([key,value])=>[String(key),String(value)]);
  return Object.entries(headers??{}).map(([key,value])=>[key,String(value)]);
};
const values=(headers,name)=>pairs(headers).filter(([key])=>key.toLowerCase()===name).map(([,value])=>value);
const coding=(headers)=>values(headers,"content-encoding").join(", ").toLowerCase();
const setHeader=(headers,name,value)=>{
  if(headers instanceof Headers){headers.set(name,value);return;}
  if(Array.isArray(headers)){
    for(let i=headers.length-1;i>=0;i--)if(headers[i][0].toLowerCase()===name.toLowerCase())headers.splice(i,1);
    headers.push([name,value]);return;
  }
  for(const key of Object.keys(headers))if(key.toLowerCase()===name.toLowerCase())delete headers[key];
  headers[name]=value;
};
const forms=[
  {name:"object",make:(entries)=>Object.fromEntries(entries),body:(text)=>text},
  {name:"Headers",make:(entries)=>new Headers(entries),body:(text)=>Buffer.from(text)},
  {name:"tuple",make:(entries)=>entries.map(pair=>pair.slice()),body:(text)=>{
    const bytes=Buffer.from(text),backing=Buffer.alloc(bytes.length+14,0x78);
    bytes.copy(backing,7);
    return new Uint8Array(backing.buffer,backing.byteOffset+7,bytes.length);
  }},
];
const headersFor=(form,dir,rid,length,extra=[])=>form.make([
  ["Content-Type","application/json"],["Authorization","Bearer local-test"],
  ["X-Accel-Compress",dir],["x-ACCeL-rID",rid],["Content-Length",String(length)],...extra,
]);
const rawValues=(raw,name)=>{
  const out=[];
  for(let i=0;i<raw.length;i+=2)if(raw[i].toLowerCase()===name)out.push(raw[i+1]);
  return out;
};
const payload=(label,repetitions)=>JSON.stringify({model:"localhost-test",messages:[{role:"user",content:label+" \u4e2d\u6587 "+("recoverable context "+label+" ").repeat(repetitions)}]});
const firstText=payload("original",1300);
const recoveryText=payload("new-body",850);
const seen=[];
const sockets=new Set();
let activeApi;
const server=createServer((request,response)=>{
  if(request.url?.startsWith("/__bili/encode-stats")){
    activeApi.sendStats(response,request);
    return;
  }
  const chunks=[];
  request.on("data",(chunk)=>chunks.push(chunk));
  request.on("end",()=>{
    seen.push({url:request.url,headers:request.headers,raw:request.rawHeaders.slice(),body:Buffer.concat(chunks)});
    response.writeHead(200,{"content-type":"application/json"});
    response.end('{"ok":true}');
  });
});
server.on("connection",(socket)=>{
  sockets.add(socket);
  socket.on("close",()=>sockets.delete(socket));
});
let base;
let cases=0;
let requests=0;
const checkWire=(record,expected,encoding,label)=>{
  const lengths=rawValues(record.raw,"content-length");
  assert.equal(lengths.length,1,label+": one content-length");
  assert.match(lengths[0],/^[0-9]+$/,label+": numeric content-length");
  assert.equal(Number(lengths[0]),record.body.length,label+": actual content-length");
  assert.equal(rawValues(record.raw,"x-accel-compress").length,0,label+": directive is private");
  assert.equal(rawValues(record.raw,"x-accel-rid").length,0,label+": rid is private");
  assert.equal(coding(record.headers),encoding,label+": content-encoding");
  const decoded=encoding==="gzip"?gunzipSync(record.body):encoding==="br"?brotliDecompressSync(record.body):record.body;
  assert.deepEqual(decoded,Buffer.from(expected),label+": exact decoded body");
};
const send=async(api,opts,text,encoding,label,path="/v1/chat/completions")=>{
  const url=base+path;
  activeApi=api;
  api.encode(opts,url);
  const before=seen.length;
  const response=await fetch(url,{...opts,signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200,label+": localhost status");
  await response.arrayBuffer();
  assert.equal(seen.length,before+1,label+": receiver saw request");
  const record=seen.at(-1);
  checkWire(record,text,encoding,label);
  requests++;
  return record;
};
const getStats=async(api,rid)=>{
  activeApi=api;
  const response=await fetch(base+"/__bili/encode-stats"+(rid?"?rid="+encodeURIComponent(rid):""),{signal:AbortSignal.timeout(5000)});
  assert.equal(response.status,200,"encode-stats status");
  assert.equal(response.headers.get("cache-control"),"no-store","encode-stats cache policy");
  const body=await response.json();
  assert.equal(typeof body.now,"number");
  return body.records;
};
const expectRecords=(records,dir,rid,texts,recordsOnWire,encoding)=>{
  assert.equal(records.length,texts.length,rid+": receipt count");
  records.forEach((record,i)=>{
    assert.equal(record.rid,rid,rid+": stable rid");
    assert.equal(record.dir,dir,rid+": stable directive");
    assert.equal(record.origBytes,Buffer.byteLength(texts[i]),rid+": original plaintext bytes");
    assert.equal(record.wireBytes,recordsOnWire[i].body.length,rid+": wire bytes");
    const expectedEncoding=Array.isArray(encoding)?encoding[i]:encoding;
    assert.equal(record.encoding,expectedEncoding||"none",rid+": receipt encoding");
  });
};

try{
  mkdirSync(stateDir,{recursive:true});
  await new Promise((done,reject)=>{
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{server.off("error",reject);done();});
  });
  base="http://127.0.0.1:"+server.address().port;
  for(const form of forms){
    for(const dir of ["gzip","br","off","on"]){
      const api=fresh(),rid="retry-"+form.name+"-"+dir;
      const encoding=dir==="off"?"":dir==="on"?"gzip":dir;
      const originalHeaders=headersFor(form," "+dir.toUpperCase()+" ",rid,Buffer.byteLength(firstText),form.name==="Headers"||dir==="off"?[]:[["content-LENGTH",String(Buffer.byteLength(firstText))]]);
      const originalSnapshot=pairs(originalHeaders);
      const opts={method:"POST",headers:originalHeaders,body:form.body(firstText)};
      const first=await send(api,opts,firstText,encoding,rid+": first");
      assert.deepEqual(pairs(originalHeaders),originalSnapshot,rid+": source headers unchanged");
      const compressedBuffer=opts.body;
      const retainedHeaders=opts.headers;
      const retainedSnapshot=pairs(retainedHeaders);
      fallback("br");
      const second=await send(api,opts,firstText,encoding,rid+": same buffer");
      assert.strictEqual(opts.body,compressedBuffer,rid+": no double compression");
      assert.deepEqual(second.body,first.body,rid+": identical retry wire bytes");
      const afterSecond=pairs(opts.headers);
      const nextHeaders=api.plaintextHeaders(opts.headers);
      assert.notStrictEqual(nextHeaders,opts.headers,rid+": independent recovery headers");
      assert.equal(coding(nextHeaders),"",rid+": own encoding cleared for plaintext");
      assert.equal(values(nextHeaders,"content-length").length,0,rid+": old length cleared");
      assert.equal(values(nextHeaders,"x-accel-compress").length,0,rid+": no directive in recovered headers");
      assert.equal(values(nextHeaders,"x-accel-rid").length,0,rid+": no rid in recovered headers");
      assert.deepEqual(pairs(opts.headers),afterSecond,rid+": recovery leaves source unchanged");
      assert.deepEqual(pairs(retainedHeaders),retainedSnapshot,rid+": previous send headers unchanged");
      const next={...opts,headers:nextHeaders,body:form.body(recoveryText)};
      assert.equal(Object.hasOwn(next,"__biliCompress"),false,rid+": spread loses legacy option metadata");
      assert.equal(Object.hasOwn(next,"__biliRid"),false,rid+": spread loses legacy rid");
      const third=await send(api,next,recoveryText,encoding,rid+": new plaintext",form.name==="Headers"?"/v1/messages":form.name==="tuple"?"/v1/responses":"/v1/chat/completions");
      expectRecords(await getStats(api,rid),dir,rid,[firstText,firstText,recoveryText],[first,second,third],encoding);
      cases++;
    }
  }
  console.log("  retry chains: object / Headers / tuple; gzip / br / off / on");

  for(const form of forms){
    for(const dir of ["gzip","br","off","on"]){
      const api=fresh(),rid="projection-"+form.name+"-"+dir;
      const encoding=dir==="off"?"":dir==="on"?"gzip":dir;
      const sourceHeaders=headersFor(form,dir,rid,Buffer.byteLength(firstText),[["Connection","close"],["X-Test-Session","private"]]);
      const opts={method:"POST",headers:sourceHeaders,body:firstText};
      await send(api,opts,firstText,encoding,rid+": first");
      const projection=Object.fromEntries(pairs(opts.headers).filter(([key])=>!["connection","x-test-session","x-accel-compress","x-accel-rid"].includes(key.toLowerCase())));
      projection["cOnTeNt-LeNgTh"]="1";
      const projectionSnapshot=pairs(projection),sourceSnapshot=pairs(opts.headers);
      fallback("br");
      const nextHeaders=api.plaintextHeaders(opts.headers,projection);
      assert.notStrictEqual(nextHeaders,projection,rid+": independent projected headers");
      assert.deepEqual(pairs(projection),projectionSnapshot,rid+": projected source unchanged");
      assert.deepEqual(pairs(opts.headers),sourceSnapshot,rid+": encoding source unchanged");
      assert.equal(coding(nextHeaders),"",rid+": projection owned encoding cleared");
      assert.equal(values(nextHeaders,"content-length").length,0,rid+": projected length cleared");
      assert.equal(values(nextHeaders,"connection").length,0,rid+": hop filter preserved");
      assert.equal(values(nextHeaders,"x-test-session").length,0,rid+": session filter preserved");
      assert.deepEqual(values(nextHeaders,"authorization"),["Bearer local-test"],rid+": auth preserved");
      const next={method:"POST",headers:nextHeaders,body:recoveryText};
      await send(api,next,recoveryText,encoding,rid+": projected plaintext");
      const rawProjection=Object.fromEntries(pairs(sourceHeaders).filter(([key])=>!["connection","x-test-session","x-accel-compress","x-accel-rid"].includes(key.toLowerCase())));
      const fromRaw={method:"POST",headers:api.plaintextHeaders(sourceHeaders,rawProjection),body:recoveryText};
      const last=await send(api,fromRaw,recoveryText,encoding,rid+": original-source projection");
      const records=await getStats(api,rid);
      assert.equal(records.length,3,rid+": source policy retains rid");
      assert.equal(records.at(-1).origBytes,Buffer.byteLength(recoveryText),rid+": projected original bytes");
      assert.equal(records.at(-1).wireBytes,last.body.length,rid+": projected wire bytes");
      assert.equal(records.at(-1).dir,dir,rid+": source policy retains directive");
      cases++;
    }
  }
  console.log("  plaintext projections: preserve source policy, auth, and caller filters");

  for(const form of forms){
    for(const encoding of ["gzip","br"]){
      const api=fresh(),rid="precompressed-"+form.name+"-"+encoding;
      const compress=encoding==="gzip"?gzipSync:brotliCompressSync;
      const firstBody=compress(Buffer.from(firstText));
      const opts={method:"POST",headers:headersFor(form,"on",rid,firstBody.length,[["CoNtEnT-EnCoDiNg",encoding]]),body:firstBody};
      await send(api,opts,firstText,encoding,rid+": user precompressed");
      assert.strictEqual(opts.body,firstBody,rid+": precompressed body untouched");
      const headers=api.plaintextHeaders(opts.headers);
      assert.equal(coding(headers),encoding,rid+": user encoding preserved");
      assert.equal(values(headers,"content-length").length,0,rid+": user old length cleared");
      const nextBody=compress(Buffer.from(recoveryText));
      const next={...opts,headers,body:nextBody};
      await send(api,next,recoveryText,encoding,rid+": user next body");
      assert.strictEqual(next.body,nextBody,rid+": next precompressed body untouched");
      assert((await getStats(api,rid)).every(record=>record.encoding==="none"),rid+": no encoder-owned compression claimed");

      const generated={method:"POST",headers:headersFor(form,"gzip",rid+"-override",Buffer.byteLength(firstText)),body:firstText};
      await send(api,generated,firstText,"gzip",rid+": generated");
      setHeader(generated.headers,"Content-Encoding","br");
      const overridden=api.plaintextHeaders(generated.headers);
      assert.equal(coding(overridden),"br",rid+": changed user encoding retained");
      const overrideBody=brotliCompressSync(Buffer.from(recoveryText));
      const overrideOpts={method:"POST",headers:overridden,body:overrideBody};
      await send(api,overrideOpts,recoveryText,"br",rid+": user override");
      assert.strictEqual(overrideOpts.body,overrideBody,rid+": user override not encoded twice");
      cases++;
    }
  }
  console.log("  precompressed bodies and later user encoding overrides pass through");

  const randomish=Buffer.alloc(4096);
  let randomState=0x6d2b79f5;
  for(let i=0;i<randomish.length;i++){
    randomState^=randomState<<13;randomState^=randomState>>>17;randomState^=randomState<<5;
    randomish[i]=randomState&255;
  }
  for(const encoding of ["gzip","br"]){
    const api=fresh(),rid="limits-"+encoding;
    const small="a".repeat(1023);
    const opts={method:"post",headers:headersFor(forms[0],encoding,rid,small.length),body:small};
    const first=await send(api,opts,small,"",rid+": below 1024");
    const threshold="a".repeat(1024);
    const next={...opts,headers:api.plaintextHeaders(opts.headers),body:threshold};
    const second=await send(api,next,threshold,encoding,rid+": exactly 1024");
    expectRecords(await getStats(api,rid),encoding,rid,[small,threshold],[first,second],["",encoding]);
    // The two rows intentionally have different results at the byte threshold.
    assert.equal(api.ring[0].encoding,"none");
    assert.equal(api.ring[1].encoding,encoding);
    const noise={method:"POST",headers:headersFor(forms[0],encoding,rid+"-noise",randomish.length),body:randomish};
    await send(api,noise,randomish,"",rid+": savings under five percent");
    assert.strictEqual(noise.body,randomish,rid+": insufficient savings unchanged");
    cases++;
  }
  console.log("  POST, 1024-byte threshold, and five-percent savings guard");

  for(const form of forms){
    const api=fresh(),rid="ineligible-"+form.name;
    const unsupported={method:"POST",headers:headersFor(form,"gzip",rid,Buffer.byteLength(firstText)),body:firstText};
    await send(api,unsupported,firstText,"",rid+": unsupported target","/other-endpoint");
    assert.equal(api.ring.length,0,rid+": no model receipt for unsupported target");
    const get={method:"GET",headers:headersFor(form,"gzip",rid+"-get",0)};
    api.encode(get,base+"/v1/messages");
    assert.equal(values(get.headers,"x-accel-compress").length,0,rid+": non-POST directive stripped");
    assert.equal(values(get.headers,"x-accel-rid").length,0,rid+": non-POST rid stripped");
    assert.equal(coding(get.headers),"",rid+": GET not compressed");
    cases++;
  }
  const frozen=fresh(),frozenSource=Object.freeze(Object.fromEntries([["X-Accel-Compress","off"],["X-Accel-Rid","frozen"]]));
  const frozenOpts={method:"POST",headers:frozenSource,body:firstText};
  await send(frozen,frozenOpts,firstText,"","frozen source");
  assert.notStrictEqual(frozenOpts.headers,frozenSource,"frozen source copied");
  const freshHeaders=frozen.plaintextHeaders(frozenSource);
  await send(frozen,{method:"POST",headers:freshHeaders,body:recoveryText},recoveryText,"","plaintext API before encoding");
  cases++;
  console.log("  internal directives stay private on every path; frozen sources work");

  const capped=fresh();
  for(let i=0;i<360;i++)capped.encode({method:"POST",headers:{"x-accel-rid":"ring-"+i,"x-accel-compress":"off"},body:"small"},base+"/v1/responses");
  assert.equal(capped.ring.length,300,"receipt ring cap");
  assert.equal(capped.ring[0].rid,"ring-60","receipt ring evicts oldest");
  const recent=await getStats(capped);
  assert.equal(recent.length,100,"unfiltered stats returns last 100");
  assert.equal(recent[0].rid,"ring-260","recent stats starts at last 100");
  assert.deepEqual(await getStats(capped,"ring-0"),[],"evicted rid absent");
  assert.equal((await getStats(capped,"ring-359")).length,1,"rid filter finds retained row");
  capped.encode({method:"POST",headers:{"x-accel-compress":"off"},body:"small"},base+"/v1/responses");
  assert.equal(capped.ring.length,300,"missing rid does not add receipt");
  cases++;
  console.log("  localhost encode-stats filtering and 300-row ring");
  console.log("outbound-encoding: OK - "+cases+" cases, "+requests+" real localhost sends on Node "+process.version+(blockOnly?" (source block)":" (candidate build)"));
}catch(error){
  console.error("outbound-encoding: FAILED - "+(error?.stack??String(error)));
  process.exitCode=1;
}finally{
  try{
    const closed=[...sockets].map(socket=>new Promise(done=>{socket.once("close",done);socket.destroy();}));
    server.closeAllConnections();
    await new Promise((done)=>server.close(done));
    await Promise.all(closed);
    assert.equal(sockets.size,0,"all receiver sockets closed");
  }finally{
    assert.equal(dirname(resolve(scratch)),scratchRoot,"temporary directory stays within scratch root");
    assert(basename(scratch).startsWith("bili-outbound-check-"),"temporary directory belongs to this check");
    rmSync(scratch,{recursive:true,force:true});
  }
}
