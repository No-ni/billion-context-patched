#!/usr/bin/env node
// A mock supervisor proves discovery and process replacement without stopping DSH.
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const state = mkdtempSync(join(tmpdir(),"bili-check-restart-"));
let instance = "old-test-instance";
let shutdowns = 0;
const server = createServer((request,response) => {
  response.setHeader("content-type","application/json");
  if(request.url === "/__bili/shutdown" && request.method === "POST") {
    shutdowns++;
    instance="new-test-instance";
    response.writeHead(202);
    response.end('{"ok":true}');
  } else if(request.url === "/__bili/health") {
    response.end(JSON.stringify({ok:true,instanceId:instance,pid:instance.startsWith("old")?1000:1001,version:"test"}));
  } else { response.writeHead(404); response.end("{}"); }
});
try {
  await new Promise(done=>server.listen(0,"127.0.0.1",done));
  mkdirSync(join(state,"billion-context"));
  writeFileSync(join(state,"billion-context","proxy-origin"),JSON.stringify({port:server.address().port}));
  const env={...process.env,XDG_STATE_HOME:state};
  delete env.BILI_PORT;
  const result=await promisify(execFile)(process.execPath,[fileURLToPath(new URL("./restart.mjs",import.meta.url))],{env,timeout:10000});
  assert.equal(shutdowns,1);
  assert(result.stdout.includes("old-test-ins") && result.stdout.includes("new-test-ins"));
  console.log("restart: discovered dynamic port and verified replacement identity");
} finally {
  await new Promise(done=>server.close(done));
  rmSync(state,{recursive:true,force:true});
}
