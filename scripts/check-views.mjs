#!/usr/bin/env node
// Exercise the actual shipped functions without starting the proxy or using its DB.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";

const dist = process.argv[2] ?? new URL("../vendor/billion-context/dist/index.js", import.meta.url);
const source = readFileSync(dist, "latin1");
const span = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert(a >= 0 && b > a, "missing build span: " + start);
  return source.slice(a, b);
};
const msg = (id, text = id) => ({id, role:"user", contentType:"text", text});
const block = (id, ids) => ({blockId:id, effectiveMessageIds:ids, active:true});
const a = msg("a"), b = msg("b"), c = msg("c"), x = msg("x");
let db = [a,b];
const rows = () => db.map((m, seq) => ({seq, msgId:m.id, content:JSON.stringify(m)}));
const store = {
  unifiedMessageIdRows: rows,
  unifiedTailSeqs: () => db.map((_, seq) => seq),
  unifiedMessageRows: rows,
  unifiedUncoveredRows: (_, intervals) => rows().filter(r => !intervals.some(([a,b]) => r.seq >= a && r.seq <= b)),
};
const api = runInNewContext(
  span("function __biliPrefixDigest(", "const __biliPinnedViews=") +
  "\nconst __biliPinnedViews=new Map();\n" +
  span("function parseRow(", "var SnapshotAnchorFallbackError=") +
  span("function buildAnchoredView(", "function __biliPluginLaneSnapshot(") +
  "\n({buildView,buildAnchoredView,__biliPinViewRecord,__biliStickyView,__biliForkPinView,__biliPinnedViews});",
  {require:createRequire(import.meta.url), getStore:()=>store,
   MAX_CHAIN_WALK:8192, MIN_SEAM_RUN:2, __biliPinLog:()=>{},
   identitySig:m=>`${m.role}|${m.contentType}|${m.text}`, console:{warn:()=>{}}}
);
const session = {id:"test", metadata:{}, state:{blocks:[block("old",["a","b"]),block("new",["x"])]}};
let checks = 0;
const check = (name, fn) => { fn(); checks++; console.log("  OK " + name); };
check("newest missing block survives in the client suffix", () => {
  const r = api.buildView(session,[a,b,x]);
  assert(r.ok && r.view.some(m=>m.id==="x"));
});
check("older missing block is rejected", () => {
  session.state.blocks.reverse();
  assert.equal(api.buildView(session,[a,b,x]).reason,"block-unanchored");
  session.state.blocks.reverse();
});
check("sole missing block is rejected", () => {
  const state = session.state;
  session.state = {blocks:[block("new",["x"])]};
  assert.equal(api.buildView(session,[a,b,x]).reason,"block-unanchored");
  session.state = state;
});
check("missing message before the seam cannot disappear", () => {
  db = [a,b,c];
  assert.equal(api.buildView(session,[a,b,x,c]).reason,"skipped-block-not-in-tail");
});
check("a partially supplied missing block is rejected", () => {
  session.state.blocks[1].effectiveMessageIds.push("y");
  assert.equal(api.buildView(session,[a,b,c,x]).reason,"skipped-block-not-in-tail");
  session.state.blocks[1].effectiveMessageIds.pop();
});
check("delta/WS seam requires the same coverage proof", () => {
  assert.equal(api.buildAnchoredView(session,[],"user|text|c").reason,"skipped-block-not-in-tail");
  assert(api.buildAnchoredView(session,[x],"user|text|c").ok);
});
const deps = {pluginMode:true};
const pinned = [msg("acp_summary_old"),c];
const pin = (messages=[a,b,c]) => api.__biliPinViewRecord(session,messages,pinned);
const sticky = messages => api.__biliStickyView(session,messages,deps,"test");
pin();
check("unchanged prefix appends new messages", () => {
  assert.equal(sticky([a,b,c,x]).at(-1).id,"x");
  assert.equal(session.metadata.snapshotRenderTailStart,pinned.length);
});
check("earlier prefix edits reject the pin", () => assert.equal(sticky([msg("a","edited"),b,c]),null));
check("edits beyond character 200 reject the pin", () => {
  const long = msg("c","z".repeat(400));
  pin([a,b,long]);
  assert.equal(sticky([a,b,{...long,text:long.text+"changed"}]),null);
  pin();
});
check("removed summary placeholders reject the pin", () => {
  session.state.blocks[0].active=false;
  assert.equal(sticky([a,b,c]),null);
  session.state.blocks[0].active=true;
});
check("retirement, rewrite and changed coverage reject old layouts", () => {
  const old = session.state.blocks[0];
  old.retired = true;
  assert.equal(sticky([a,b,c]), null);
  delete old.retired;
  old.summary = "corrected summary";
  assert.equal(sticky([a,b,c]), null);
  delete old.summary;
  old.effectiveMessageIds.push("c");
  assert.equal(sticky([a,b,c]), null);
  old.effectiveMessageIds.pop();
  assert(sticky([a,b,c]));
});
check("restoring a retired block invalidates a pin without its summary", () => {
  session.state.blocks[0].retired = true;
  api.__biliPinViewRecord(session, [a,b,c], [c]);
  assert(sticky([a,b,c]));
  delete session.state.blocks[0].retired;
  assert.equal(sticky([a,b,c]), null);
  pin();
});
check("unrelated tail blocks and counters do not invalidate the prefix", () => {
  const tail = session.state.blocks[1];
  tail.summary = "tail changed";
  tail.retired = true;
  session.state.stats = { compressionCount: 999 };
  assert(sticky([a,b,c,x]));
  delete tail.summary;
  delete tail.retired;
});
check("shorter history, excessive tail and tool-first tail reject", () => {
  assert.equal(sticky([a,b]),null);
  assert.equal(sticky([a,b,c,...Array.from({length:9},(_,i)=>msg("n"+i))]),null);
  assert.equal(sticky([a,b,c,{...x,role:"tool"}]),null);
});
check("fork checks the whole prefix and records a child pin", () => {
  const child={id:"child",metadata:{parentConversationId:"test"},state:session.state};
  assert.equal(api.__biliForkPinView(child,[msg("a","edited"),b,c,x],deps),null);
  assert.equal(api.__biliForkPinView(child,[a,b,c,x],deps).at(-1).id,"x");
  assert(api.__biliPinnedViews.has("child"));
  assert.equal(api.__biliForkPinView(child,[a,b,c,x],deps),null);
});
check("pin table remains bounded", () => {
  for(let i=0;i<20;i++) api.__biliPinViewRecord({...session,id:"p"+i},[a,b,c],pinned);
  assert.equal(api.__biliPinnedViews.size,8);
});
check("cache keys follow nested fork ancestry and stay bounded", () => {
  const keys=runInNewContext(span("const __biliPckChain=", "function __biliEncodeOutbound(") +
    "\n({key:__biliForkPck,map:__biliPckChain});", {__biliPluginLaneSnapshot:()=>true});
  assert.equal(keys.key({id:"root",metadata:{}}),"root");
  assert.equal(keys.key({id:"child",metadata:{parentConversationId:"root"}}),"root");
  assert.equal(keys.key({id:"grandchild",metadata:{parentConversationId:"child"}}),"root");
  for(let i=0;i<600;i++) keys.key({id:"k"+i,metadata:{}});
  assert.equal(keys.map.size,512);
});
check("fork timestamps copy only the inherited prefix", () => {
  const helpers=span("function __biliCopyForkTimestamps(", "function loadTranscriptBase(");
  const parent={state:{nextRunId:7,tsStamps:{a:10,b:20,c:30,bad:NaN},messageRefs:{byRaw:{a:"m00001",b:"m00002",c:"m00003",future:"m00004","bili:ref-floor":"m00005"}}}};
  const child={state:{}};
  runInNewContext(helpers + span("child.state.nextRunId=parent.state.nextRunId;", "child.state.lastPassIds="),
    {parent,child,prefix:[{rawId:"a"},{rawId:"b"}]});
  assert.equal(child.state.nextRunId,7);
  assert.equal(child.state.tsStamps.a,10);
  assert.equal(child.state.tsStamps.c,undefined);
  child.state.tsStamps.a=99;
  assert.equal(parent.state.tsStamps.a,10);
  assert.deepEqual(Array.from(child.state.__biliForkTsPending),["c","future"]);
  assert(!Object.hasOwn(child.state,"suppressMintingOnce"));
  assert(!Object.hasOwn(child.state,"__biliForkTsVisible"));
});
let forkTimestampNow=1000;
const forkTimes=runInNewContext(
  span("function __biliCopyForkTimestamps(","function loadTranscriptBase(") +
  span("function createStampTimestampsNode(","function applySingleRange(") +
  "\n({copy:__biliCopyForkTimestamps,node:createStampTimestampsNode});",
  {Date:{now:()=>forkTimestampNow},RETRIEVED_ID_PREFIX:"retrieved:",highestUsedIndex:()=>5,
   refToIndex:ref=>/^m\d+$/.test(ref)?Number(ref.slice(1)):null}
);
const timestampInput=(state,messages)=>({state,messages});
check("new fork messages get the child clock even in the reserved parent namespace",()=>{
  const parent={state:{messageRefs:{byRaw:{a:"m00001",c:"m00003",future:"m00004"}},tsStamps:{a:10,c:30},timestampsHighWaterRefSeq:0}};
  const child={state:{messageRefs:structuredClone(parent.state.messageRefs),timestampsHighWaterRefSeq:0}};
  forkTimes.copy(child,parent,[{rawId:"a"}]);
  const result=forkTimes.node(true).run(timestampInput(child.state,[msg("a"),msg("c"),msg("fresh")]));
  assert.equal(result.messages[0].ts,10);
  assert.equal(result.messages[1].ts,1000);
  assert.equal(result.messages[2].ts,1000);
  assert.equal(result.state.tsStamps.c,1000);
  assert.equal(parent.state.tsStamps.c,30);
  assert.deepEqual(Array.from(result.state.__biliForkTsPending),["future"]);
  const next=forkTimes.node(true).run(timestampInput(result.state,[msg("a"),msg("c"),msg("fresh")]));
  assert.equal(next.messages[1].ts,1000);
});
check("fork clocks replay fresh raw messages below the inherited high-water mark",()=>{
  const parent={state:{messageRefs:{byRaw:{a:"m00001",hidden:"m00002",c:"m00003",future:"m00004"}},
    tsStamps:{a:10,hidden:20,c:30},__biliForkTsVisible:["a"],timestampsHighWaterRefSeq:5}};
  const child={state:{messageRefs:structuredClone(parent.state.messageRefs),timestampsHighWaterRefSeq:5}};
  forkTimes.copy(child,parent,[{rawId:"a"},{rawId:"hidden"}]);
  const raw=()=>[msg("a"),msg("hidden"),msg("c")];
  const first=forkTimes.node(true).run(timestampInput(child.state,raw()));
  assert.equal(first.messages[0].ts,10);
  assert.equal(first.messages[1].ts,undefined);
  assert.equal(first.messages[2].ts,1000);
  assert.deepEqual(Array.from(first.state.__biliForkTsVisible),["a","c"]);
  assert.deepEqual(Array.from(child.state.__biliForkTsVisible),["a"]);
  forkTimestampNow=2000;
  try {
    const second=forkTimes.node(true).run(timestampInput(first.state,[...raw(),msg("future")]));
    assert.equal(second.messages[2].ts,1000);
    assert.equal(second.messages[3].ts,2000);
    assert.equal(second.messages[1].ts,undefined);
    assert(!Object.hasOwn(second.state,"__biliForkTsPending"));
    forkTimestampNow=3000;
    const third=forkTimes.node(true).run(timestampInput(second.state,[...raw(),msg("future")]));
    assert.equal(third.messages[2].ts,1000);
    assert.equal(third.messages[3].ts,2000);
    assert.equal(third.state.timestampsHighWaterRefSeq,5);
    const grandchild={state:{messageRefs:structuredClone(second.state.messageRefs),timestampsHighWaterRefSeq:5}};
    forkTimes.copy(grandchild,{state:second.state},[{rawId:"a"},{rawId:"c"}]);
    assert.deepEqual(Array.from(grandchild.state.__biliForkTsVisible),["a","c"]);
    const inherited=forkTimes.node(true).run(timestampInput(grandchild.state,[msg("a"),msg("c")]));
    assert.equal(inherited.messages[1].ts,1000);
    grandchild.state.tsStamps.c=999;
    grandchild.state.__biliForkTsVisible.push("isolated");
    assert.equal(second.state.tsStamps.c,1000);
    assert(!second.state.__biliForkTsVisible.includes("isolated"));
  } finally {forkTimestampNow=1000;}
  assert.equal(parent.state.tsStamps.c,30);
  assert.deepEqual(Array.from(parent.state.__biliForkTsVisible),["a"]);
});
check("disabled first sightings and ambiguous resumed history stay honestly unstamped",()=>{
  const state={messageRefs:{byRaw:{old:"m00001",later:"m00002"}},__biliForkTsPending:["old","later"],timestampsHighWaterRefSeq:5};
  const disabled=forkTimes.node(false).run(timestampInput(state,[msg("old")]));
  assert.deepEqual(Array.from(disabled.state.__biliForkTsPending),["later"]);
  assert(!Object.hasOwn(disabled.state,"tsStamps"));
  const enabled=forkTimes.node(true).run(timestampInput(disabled.state,[msg("old"),msg("later")]));
  assert.equal(enabled.messages[0].ts,undefined);
  assert.equal(enabled.messages[1].ts,1000);
  assert(!Object.hasOwn(enabled.state,"__biliForkTsPending"));
  assert.deepEqual(Array.from(enabled.state.__biliForkTsVisible),["later"]);
  const disabledAgain=forkTimes.node(false).run(timestampInput(enabled.state,[msg("old"),msg("later")]));
  assert.equal(disabledAgain.messages[1].ts,undefined);
  const replay=forkTimes.node(true).run(timestampInput(disabledAgain.state,[msg("old"),msg("later")]));
  assert.equal(replay.messages[0].ts,undefined);
  assert.equal(replay.messages[1].ts,1000);
  const ambiguous=forkTimes.node(true).run(timestampInput({messageRefs:{byRaw:{}},suppressMintingOnce:true},[msg("unknown")]));
  assert.equal(ambiguous.messages[0].ts,undefined);
  assert(!Object.hasOwn(ambiguous.state,"suppressMintingOnce"));
  assert(!Object.hasOwn(ambiguous.state,"__biliForkTsVisible"));
});
check("fork timestamp proofs stay bounded by the issued namespace",()=>{
  const state={messageRefs:{byRaw:{a:"m00001",later:"m00002"}},tsStamps:{a:10,orphan:20},
    __biliForkTsVisible:["a","a","orphan"],__biliForkTsPending:["later","later","missing"],timestampsHighWaterRefSeq:5};
  const cleaned=forkTimes.node(true).run(timestampInput(state,[]));
  assert.deepEqual(Array.from(cleaned.state.__biliForkTsVisible),["a"]);
  assert.deepEqual(Array.from(cleaned.state.__biliForkTsPending),["later"]);
  assert.equal(state.__biliForkTsVisible.length,3);
  assert.equal(state.__biliForkTsPending.length,3);
});
check("fork pending observations survive sync, fold, hydration and unified persistence",()=>{
  const context={scrubTurnSeparatorIds:()=>{},__esm:init=>Object.values(init)[0],init_state:()=>{},init_turn_separator:()=>{}};
  const persisted=runInNewContext(
    span("function createInitialState2(","var init_state=")+
    span("function syncBlocks(","function defaultConfig(")+
    span("function cloneState(","function scoreRelevance(")+
    span("function mergeState(","function toLegacyLike(")+"\ninit_state_hydration();\n({initial:createInitialState2,sync:syncBlocks,clone:cloneState,merge:mergeState,fields:COMPRESSION_STATE_FIELDS});",context);
  const state=persisted.initial();
  state.__biliForkTsPending=["reserved"];
  state.__biliForkTsVisible=["a"];
  state.messageRefs.byRaw={a:"m00001",reserved:"m00004"};
  state.timestampsHighWaterRefSeq=5;
  state.tsStamps={a:10};
  const copies=[persisted.sync([],state).state,persisted.clone(state),persisted.merge(JSON.parse(JSON.stringify(state)))];
  for(const copy of copies){
    assert.deepEqual(Array.from(copy.__biliForkTsPending),["reserved"]);
    assert.deepEqual(Array.from(copy.__biliForkTsVisible),["a"]);
    copy.__biliForkTsPending.push("isolated");
    copy.__biliForkTsVisible.push("isolated");
    assert.equal(state.__biliForkTsPending.length,1);
    assert.equal(state.__biliForkTsVisible.length,1);
  }
  assert(persisted.fields.includes("__biliForkTsPending"));
  assert(persisted.fields.includes("__biliForkTsVisible"));
  assert(!Object.hasOwn(persisted.merge(persisted.initial()),"__biliForkTsPending"));
  assert(!Object.hasOwn(persisted.merge(persisted.initial()),"__biliForkTsVisible"));
  const reloaded=persisted.merge(JSON.parse(JSON.stringify(state)));
  reloaded.messageRefs.byRaw.reserved="m00004";
  reloaded.timestampsHighWaterRefSeq=0;
  assert.equal(forkTimes.node(true).run(timestampInput(reloaded,[msg("reserved")])).messages[0].ts,1000);
  const first=forkTimes.node(true).run(timestampInput(state,[msg("a"),msg("reserved")]));
  const persistedTurn=JSON.parse(JSON.stringify(first.state));
  const foldedCopies=[persisted.sync([],first.state).state,persisted.clone(first.state),persisted.merge(persistedTurn)];
  for(const copy of foldedCopies){
    const replay=forkTimes.node(true).run(timestampInput(copy,[msg("a"),msg("reserved")]));
    assert.equal(replay.messages[0].ts,10);
    assert.equal(replay.messages[1].ts,1000);
    assert.equal(replay.state.timestampsHighWaterRefSeq,5);
  }
});
check("cache-key routing defaults to enabled and preserves explicit choices", () => {
  const routing = runInNewContext(
    span("function parsePromptCacheRouting(", "function parseUpstreamProxyMode(") +
    "\n({parse:parsePromptCacheRouting,effective:effectivePromptCacheRouting});"
  );
  for (const value of [undefined, null, "", "invalid"]) {
    assert.equal(routing.parse(value), "enabled");
    assert.equal(routing.effective({routing:value}), "enabled");
  }
  assert.equal(routing.effective(undefined), "enabled");
  for (const value of ["disabled", "auto", "enabled"]) {
    assert.equal(routing.parse(value), value);
    assert.equal(routing.effective({routing:value}), value);
  }
});
check("settings show enabled by default and preserve explicit routing", () => {
  const start = source.indexOf("const pcv = ");
  assert(start >= 0, "missing settings routing selector");
  const expression = source.slice(start, source.indexOf(";", start) + 1) + "\npcv";
  for (const draft of [{}, {promptCache:{}}, {promptCache:null}]) {
    assert.equal(runInNewContext(expression, {draft}), "enabled");
  }
  for (const routing of ["disabled", "auto", "enabled"]) {
    assert.equal(runInNewContext(expression, {draft:{promptCache:{routing}}}), routing);
  }
  assert(!source.includes('"cfg.q_pck_disabled_desc":"Off (current default):'));
  assert(source.includes('"cfg.q_pck_enabled_desc":"Force on (current default):'));
  assert(!source.includes("\"cfg.q_pck_disabled_desc\":\"\\u5173\\u95ED\\uFF08"));
  assert(source.includes("\"cfg.q_pck_enabled_desc\":\"\\u5F3A\\u5236\\u5F00\\u542F\\uFF08"));
});
check("nudge growth default is 80k", () => {
  assert(source.includes("growthFloor:8e4,growthCap:8e4"));
  assert(source.includes("const NUDGE_DEFAULT = 80000, NUDGE_STEP = 5000"));
  assert(source.includes("kernel default 80000"));
  assert(source.includes("\\u9ED8\\u8BA4 80000"));
  assert(!source.includes("growthFloor:5e4,growthCap:5e4"));
  assert(!source.includes("const NUDGE_DEFAULT = 50000, NUDGE_STEP = 5000"));
  assert(!source.includes("kernel default 50000"));
});
console.log("views: " + checks + " checks passed");
