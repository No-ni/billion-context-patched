import { createServer } from "node:http";
import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import { acceptUpgrade, frame } from "./websocket.mjs";

export async function startGateway() {
  const http = [], ws = [], upgrades = [], sockets = new Set(), errors = [], gates = new Map(), plans = new Map();
  let sequence = 0;
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST") { res.setHeader("content-type", "application/json"); res.end('{"version":1,"entries":[]}'); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const wire = Buffer.concat(chunks), encoding = req.headers["content-encoding"] ?? "none";
      const decoded = encoding === "gzip" ? gunzipSync(wire) : encoding === "br" ? brotliDecompressSync(wire) : encoding === "deflate" ? inflateSync(wire) : wire;
      const body = JSON.parse(decoded.toString("utf8"));
      const record = { path: req.url, headers: { ...req.headers }, wire, decoded, body }; http.push(record);
      if (req.url.includes("fail-reset")) { req.socket.destroy(); return; }
      const gate = gates.get(req.url); if (gate) await gate.promise;
      const step = plans.get(req.url)?.shift();
      if (step?.kind === "reset") { req.socket.destroy(); return; }
      if (req.url.includes("fail-429")) { res.writeHead(429, { "content-type": "application/json", "retry-after": "1" }); res.end('{"error":{"message":"mock upstream rate limit","type":"rate_limit_error"}}'); return; }
      if (req.url.includes("fail-401")) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"mock upstream unauthorized","type":"authentication_error"}}'); return; }
      const number = ++sequence;
      const text = `MOCK_REPLY_${number}`;
      const usage = { prompt_tokens: 256, completion_tokens: 8, total_tokens: 264, prompt_tokens_details: { cached_tokens: 128 } };
      if (step?.kind === "compress") {
        if (!body.stream) throw new Error("the local compression-loop plan requires an actual streaming request");
        res.writeHead(200, { "content-type": "text/event-stream" });
        const toolCall = { index: 0, id: `call_mock_compress_${number}`, type: "function", function: { name: "compress", arguments: JSON.stringify(step.args) } };
        const event = { id: `chat_mock_${number}`, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [toolCall] }, finish_reason: "tool_calls" }], usage };
        res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`); return;
      }
      if (req.url.includes("responses")) {
        const response = { id: `resp_mock_${number}`, object: "response", status: "completed", model: body.model, output: [{ id: `msg_mock_${number}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 256, output_tokens: 8, total_tokens: 264, input_tokens_details: { cached_tokens: 128 } } };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`);
        } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(response)); }
      } else if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ id: `chat_mock_${number}`, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`);
      } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ id: `chat_mock_${number}`, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage })); }
    } catch (error) { errors.push(error); if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (req, socket, head) => {
    upgrades.push({ path: req.url, headers: { ...req.headers } });
    acceptUpgrade(req, socket, head, (opcode, payload) => {
      if (opcode !== 1) return;
      try {
        const body = JSON.parse(payload.toString("utf8")); ws.push({ path: req.url, headers: { ...req.headers }, body, raw: payload.toString("utf8") });
        const number = ++sequence, id = `resp_ws_${number}`, text = `MOCK_WS_REPLY_${number}`;
        const output = [{ id: `msg_ws_${number}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
        const response = { id, object: "response", status: "completed", model: body.model, output, usage: { input_tokens: 256, output_tokens: 8, total_tokens: 264, input_tokens_details: { cached_tokens: 128 } } };
        for (const event of [{ type: "response.created", response: { ...response, status: "in_progress", output: [] } }, { type: "response.output_text.delta", item_id: output[0].id, output_index: 0, content_index: 0, delta: text }, { type: "response.completed", response }]) socket.write(frame(JSON.stringify(event)));
      } catch (error) { errors.push(error); socket.destroy(); }
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  return { port, origin: `http://127.0.0.1:${port}`, http, ws, upgrades, errors,
    holdPath(path) { let release; const promise = new Promise(resolve => { release = resolve; }); const gate = { promise, release }; gates.set(path, gate); return { release() { gates.delete(path); release(); } }; },
    planPath(path, steps) { if (plans.has(path)) throw new Error("a local gateway plan already owns " + path); const queue = [...steps]; plans.set(path, queue); return { remaining: () => queue.length, cancel: () => plans.delete(path) }; },
    async close() { for (const gate of gates.values()) gate.release(); gates.clear(); plans.clear(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
