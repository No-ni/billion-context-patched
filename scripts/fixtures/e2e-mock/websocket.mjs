// Minimal RFC 6455 framing for a real local mock server and header-capable
// WHATWG-shaped client. No package install or external service is required.
import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export function frame(payload, { opcode = 1, mask = false } = {}) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const size = bytes.length;
  const n = size < 126 ? 2 : size <= 65535 ? 4 : 10;
  const head = Buffer.alloc(n + (mask ? 4 : 0));
  head[0] = 0x80 | opcode;
  head[1] = (mask ? 0x80 : 0) | (size < 126 ? size : size <= 65535 ? 126 : 127);
  if (n === 4) head.writeUInt16BE(size, 2);
  if (n === 10) head.writeBigUInt64BE(BigInt(size), 2);
  if (!mask) return Buffer.concat([head, bytes]);
  const key = randomBytes(4);
  key.copy(head, n);
  const body = Buffer.from(bytes);
  for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
  return Buffer.concat([head, body]);
}

export function readFrames(socket, onFrame, initial = Buffer.alloc(0)) {
  let pending = initial;
  let parts = [];
  let type = 1;
  const receive = chunk => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 2) {
      const fin = (pending[0] & 0x80) !== 0;
      const opcode = pending[0] & 0x0f;
      const masked = (pending[1] & 0x80) !== 0;
      let size = pending[1] & 0x7f;
      let offset = 2;
      if (size === 126) {
        if (pending.length < 4) return;
        size = pending.readUInt16BE(2); offset = 4;
      } else if (size === 127) {
        if (pending.length < 10) return;
        const long = pending.readBigUInt64BE(2);
        if (long > 16n * 1024n * 1024n) return socket.destroy(new Error("mock WebSocket frame exceeds 16 MiB"));
        size = Number(long); offset = 10;
      }
      const total = offset + (masked ? 4 : 0) + size;
      if (pending.length < total) return;
      const key = masked ? pending.subarray(offset, offset + 4) : null;
      const body = Buffer.from(pending.subarray(offset + (masked ? 4 : 0), total));
      pending = pending.subarray(total);
      if (key) for (let i = 0; i < body.length; i++) body[i] ^= key[i % 4];
      if (opcode === 0) parts.push(body);
      else if (opcode === 1 || opcode === 2) { type = opcode; parts = [body]; }
      else { onFrame(opcode, body); continue; }
      if (fin) { onFrame(type, Buffer.concat(parts)); parts = []; }
    }
  };
  socket.on("data", receive);
  if (initial.length) receive(Buffer.alloc(0));
  return () => socket.removeListener("data", receive);
}

export function acceptUpgrade(req, socket, head, onFrame) {
  const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  socket.on("error", () => {});
  return readFrames(socket, (opcode, payload) => {
    if (opcode === 9) socket.write(frame(payload, { opcode: 10 }));
    else if (opcode === 8) { socket.end(frame(payload, { opcode: 8 })); }
    else onFrame(opcode, payload);
  }, head);
}

export class LocalWebSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  readyState = 0; bufferedAmount = 0; protocol = ""; extensions = ""; binaryType = "arraybuffer";
  onopen = null; onmessage = null; onerror = null; onclose = null;
  constructor(url, options = {}) {
    super(); this.url = String(url);
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1") throw new Error("local test client only supports ws://127.0.0.1");
    const key = randomBytes(16).toString("base64");
    const req = request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, agent: false,
      headers: { ...Object.fromEntries(new Headers(options.headers)), Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": key, "Sec-WebSocket-Version": "13" } });
    this.request = req;
    req.once("upgrade", (res, socket, head) => {
      const expected = createHash("sha1").update(key + GUID).digest("base64");
      if (res.headers["sec-websocket-accept"] !== expected) return socket.destroy(new Error("mock upgrade accept mismatch"));
      this.socket = socket; this.readyState = 1;
      readFrames(socket, (opcode, payload) => {
        if (opcode === 1 || opcode === 2) this.emit("message", { data: opcode === 1 ? payload.toString("utf8") : payload });
        else if (opcode === 9) socket.write(frame(payload, { opcode: 10, mask: true }));
        else if (opcode === 8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          const reason = payload.length > 2 ? payload.subarray(2).toString() : "";
          this.closeInfo = { code, reason }; socket.end(frame(payload, { opcode: 8, mask: true }));
        }
      }, head);
      socket.on("error", error => this.emit("error", { error }));
      socket.once("close", () => { this.readyState = 3; this.emit("close", this.closeInfo ?? { code: 1006, reason: "" }); });
      this.emit("open");
    });
    req.once("response", res => { res.resume(); this.readyState = 3; this.emit("error", { error: new Error("WebSocket upgrade returned HTTP " + res.statusCode) }); this.emit("close", { code: 1006 }); });
    req.on("error", error => { if (this.readyState === 3) return; this.readyState = 3; this.emit("error", { error }); this.emit("close", { code: 1006 }); });
    req.end();
  }
  emit(type, fields = {}) { const event = Object.assign(new Event(type), fields); this.dispatchEvent(event); }
  dispatchEvent(event) { const result = super.dispatchEvent(event); this["on" + event.type]?.call(this, event); return result; }
  send(data) { if (this.readyState !== 1) throw new Error("WebSocket is not OPEN"); this.socket.write(frame(data, { mask: true })); }
  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    if (!this.socket) { this.request.destroy(); this.readyState = 3; this.emit("close", { code: 1006 }); return; }
    const body = Buffer.alloc(2 + Buffer.byteLength(reason)); body.writeUInt16BE(code, 0); body.write(reason, 2);
    this.socket.end(frame(body, { opcode: 8, mask: true }));
  }
  terminate() { this.socket?.destroy(); this.request?.destroy(); }
}
