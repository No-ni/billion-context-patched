var __biliEncZlib=(function(){var z=null;return function(){if(z===null){try{z=require("node:zlib")}catch(e){z=false}}return z}})();
function __biliHome(){try{var h=process.env.HOME||process.env.USERPROFILE;if(h)return h;return require("node:os").homedir()}catch(e){return ""}}
var __biliEncCache={mtimeMs:0,enc:""};
function __biliUpstreamEncoding(){try{var fs3=require("node:fs");var side=(__biliHome()+"/.local/state/billion-context/upstream-encoding");var st=fs3.statSync(side);if(st.mtimeMs!==__biliEncCache.mtimeMs){__biliEncCache.mtimeMs=st.mtimeMs;var v=String(fs3.readFileSync(side,"utf8")).trim().toLowerCase();__biliEncCache.enc=(v==="br"||v==="gzip")?v:"";}return __biliEncCache.enc}catch(e){}try{var f=process.env.BILI_UPSTREAM_ENCODING_FILE||(__biliHome()+"/.config/billion-context/billion-context.json");var fs2=require("node:fs");var st2=fs2.statSync(f);if(st2.mtimeMs!==__biliEncCache.mtimeMs){__biliEncCache.mtimeMs=st2.mtimeMs;var j=JSON.parse(fs2.readFileSync(f,"utf8"));var e=j&&j.upstream&&typeof j.upstream.encoding==="string"?j.upstream.encoding.toLowerCase():"";__biliEncCache.enc=(e==="br"||e==="gzip")?e:"";}}catch(e){return ""}return __biliEncCache.enc}
function __biliEncLog(line){try{require("node:fs").appendFileSync(__biliHome()+"/.local/state/billion-context/upstream-encode.log",new Date().toISOString()+" "+line+"\n")}catch(e){}}
var __biliEncRing=[];
function __biliEncPush(r){try{if(!r||!r.rid)return;__biliEncRing.push(r);if(__biliEncRing.length>300)__biliEncRing.shift()}catch(e){}}
// Header metadata never participates in an HTTP header projection. A shared
// policy survives plaintext recovery, while body/encoding provenance belongs
// to one header copy and is discarded when that copy gets a new plaintext body.
var __biliEncHeaderMeta=new WeakMap();
function __biliEncHeaderEntries(h){
  var out=[];
  if(!h||typeof h!=="object")return out;
  if(Array.isArray(h)){for(var i=0;i<h.length;i++){var pair=h[i];if(Array.isArray(pair)&&pair.length>=2)out.push([String(pair[0]),String(pair[1])])}}
  else if(typeof h.get==="function"&&typeof h.forEach==="function"){h.forEach(function(v,k){out.push([String(k),String(v)])})}
  else{var keys=Object.keys(h);for(var j=0;j<keys.length;j++)out.push([keys[j],String(h[keys[j]])])}
  return out;
}
function __biliEncHeaderRead(h,name){var entries=__biliEncHeaderEntries(h),value=null;for(var i=0;i<entries.length;i++){if(entries[i][0].toLowerCase()===name)value=value===null?entries[i][1]:value+", "+entries[i][1]}return value}
function __biliEncHeaderDelete(h,name){
  if(!h||typeof h!=="object")return;
  if(Array.isArray(h)){for(var i=h.length-1;i>=0;i--){if(Array.isArray(h[i])&&String(h[i][0]).toLowerCase()===name)h.splice(i,1)}}
  else if(typeof h.get==="function"&&typeof h.delete==="function")h.delete(name);
  else{var keys=Object.keys(h);for(var j=0;j<keys.length;j++){if(keys[j].toLowerCase()===name)delete h[keys[j]]}}
}
function __biliEncHeaderSet(h,name,value){__biliEncHeaderDelete(h,name);if(Array.isArray(h))h.push([name,value]);else if(typeof h.get==="function"&&typeof h.set==="function")h.set(name,value);else h[name]=value}
function __biliEncHeaderClone(h){
  var entries=__biliEncHeaderEntries(h);
  if(Array.isArray(h))return entries;
  if(h&&typeof h.get==="function"&&typeof h.forEach==="function"&&typeof Headers!=="undefined")return new Headers(entries);
  var out={};for(var i=0;i<entries.length;i++)Object.defineProperty(out,entries[i][0],{value:entries[i][1],enumerable:true,configurable:true,writable:true});return out;
}
function __biliEncMeta(h){return h&&typeof h==="object"?__biliEncHeaderMeta.get(h):null}
function __biliEncCoding(h){var value=__biliEncHeaderRead(h,"content-encoding");return value===null?null:value.trim().toLowerCase()}
function __biliEncOwned(h,meta){var own=meta&&meta.own;return own&&__biliEncCoding(h)===own.encoding?own:null}
function __biliEncPolicy(source,projected,opts){
  var sm=__biliEncMeta(source),pm=__biliEncMeta(projected),prior=(sm&&sm.policy)||(pm&&pm.policy);
  var dir=__biliEncHeaderRead(source,"x-accel-compress"),rid=__biliEncHeaderRead(source,"x-accel-rid");
  if(dir===null&&projected!==source)dir=__biliEncHeaderRead(projected,"x-accel-compress");
  if(rid===null&&projected!==source)rid=__biliEncHeaderRead(projected,"x-accel-rid");
  dir=dir===null?(prior?prior.dir:opts&&typeof opts.__biliCompress==="string"?opts.__biliCompress:""):dir.trim().toLowerCase();
  rid=rid===null?(prior?prior.rid:opts&&typeof opts.__biliRid==="string"?opts.__biliRid:null):(rid||null);
  var policy=prior&&prior.dir===dir&&prior.rid===rid?prior:{dir:dir,rid:rid,resolved:false,encoding:""};
  if(source&&typeof source==="object")__biliEncHeaderMeta.set(source,{policy:policy,own:sm&&sm.own,decision:sm&&sm.decision});
  return policy;
}
function __biliEncRequestHeaders(source,opts){
  var policy=__biliEncPolicy(source,source,opts),meta=__biliEncMeta(source),out=__biliEncHeaderClone(source);
  __biliEncHeaderDelete(out,"x-accel-compress");__biliEncHeaderDelete(out,"x-accel-rid");
  __biliEncHeaderMeta.set(out,{policy:policy,own:__biliEncOwned(source,meta),decision:meta&&meta.decision});return out;
}
function __biliPlaintextHeaders(sourceHeaders,projectedHeaders){
  var projected=projectedHeaders===void 0?sourceHeaders:projectedHeaders;
  var policy=__biliEncPolicy(sourceHeaders,projected),sm=__biliEncMeta(sourceHeaders),pm=__biliEncMeta(projected),out=__biliEncHeaderClone(projected);
  var own=__biliEncOwned(sourceHeaders,sm)||__biliEncOwned(projected,pm);
  if(own&&__biliEncCoding(out)===own.encoding)__biliEncHeaderDelete(out,"content-encoding");
  __biliEncHeaderDelete(out,"content-length");__biliEncHeaderDelete(out,"x-accel-compress");__biliEncHeaderDelete(out,"x-accel-rid");
  __biliEncHeaderMeta.set(out,{policy:policy,own:null,decision:null});return out;
}
function __biliTakeRid(opts){try{var h=opts&&opts.headers,value=__biliEncHeaderRead(h,"x-accel-rid");__biliEncHeaderDelete(h,"x-accel-rid");return value||null}catch(e){return null}}
function __biliTakeCompress(opts){try{var h=opts&&opts.headers,value=__biliEncHeaderRead(h,"x-accel-compress");__biliEncHeaderDelete(h,"x-accel-compress");return value===null?"":value.trim().toLowerCase()}catch(e){return""}}
function __biliSendEncStats(res,req){try{var u2=new URL(req.url||"/__bili/encode-stats","http://localhost");var rid=u2.searchParams.get("rid");var out=rid?__biliEncRing.filter(function(r){return r.rid===rid}):__biliEncRing.slice(-100);res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({now:Date.now(),records:out}))}catch(e){try{res.writeHead(500,{"content-type":"application/json"});res.end(JSON.stringify({error:String((e&&e.message)||e)}))}catch(e2){}}}
function __biliEncodeOutbound(opts,url){
  try{
    if(!opts||typeof opts!=="object")return;
    opts.headers=__biliEncRequestHeaders(opts.headers,opts);
    var h=opts.headers,meta=__biliEncMeta(h),policy=meta.policy,rid=policy.rid,dir=policy.dir,u0=String(url||"");
    try{Object.defineProperty(opts,"__biliRid",{value:rid,enumerable:false,configurable:true,writable:true});Object.defineProperty(opts,"__biliCompress",{value:dir,enumerable:false,configurable:true,writable:true})}catch(e){}
    if(u0.indexOf("/chat/completions")<0&&u0.indexOf("/v1/messages")<0&&u0.indexOf("/responses")<0)return;
    if(String(opts.method||"").toUpperCase()!=="POST"||opts.body===null||opts.body===void 0){__biliEncPush({rid:rid,ts:Date.now(),url:u0,origBytes:0,wireBytes:0,encoding:"none",dir:dir});return}
    var buf=null;if(typeof opts.body==="string")buf=Buffer.from(opts.body,"utf8");else if(Buffer.isBuffer(opts.body))buf=opts.body;else if(opts.body instanceof Uint8Array)buf=Buffer.from(opts.body.buffer,opts.body.byteOffset,opts.body.byteLength);
    if(!buf){__biliEncPush({rid:rid,ts:Date.now(),url:u0,origBytes:0,wireBytes:0,encoding:"none",dir:dir});return}
    var coding=__biliEncCoding(h),prior=meta.decision,orig=buf.length,wire=orig,used="";
    if(prior&&prior.policy===policy&&prior.body===opts.body&&prior.coding===coding){orig=prior.origBytes;wire=buf.length;used=prior.encoding==="none"?"":prior.encoding}
    else{
      var own=__biliEncOwned(h,meta);
      if(own&&own.body===opts.body){orig=own.origBytes;used=own.encoding}
      else{
        if(!policy.resolved){policy.encoding=dir==="off"?"":(dir==="gzip"||dir==="br")?dir:dir==="on"?(__biliUpstreamEncoding()||"gzip"):__biliUpstreamEncoding();policy.resolved=true}
        var enc=policy.encoding;
        if(enc&&coding===null&&orig>=1024){var z=__biliEncZlib();if(z){var out=enc==="br"?z.brotliCompressSync(buf,{params:{[z.constants.BROTLI_PARAM_QUALITY]:4}}):z.gzipSync(buf,{level:6});if(out&&out.length<orig*0.95){__biliEncHeaderDelete(h,"content-length");__biliEncHeaderSet(h,"content-encoding",enc);opts.body=out;wire=out.length;used=enc;meta.own={encoding:enc,body:out,origBytes:orig};__biliEncLog("encoded "+orig+" -> "+out.length+" ("+enc+")"+(rid?" rid="+rid:""))}}}
      }
      meta.decision={policy:policy,body:opts.body,coding:__biliEncCoding(h),origBytes:orig,wireBytes:wire,encoding:used||"none"};
    }
    __biliEncPush({rid:rid,ts:Date.now(),url:u0,origBytes:orig,wireBytes:wire,encoding:used||"none",dir:dir});
  }catch(e){__biliEncLog("error "+String((e&&e.message)||e))}
}
