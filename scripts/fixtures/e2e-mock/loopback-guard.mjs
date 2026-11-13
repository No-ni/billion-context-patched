// Test-only egress guard. It changes no model/proxy code and permits real local
// sockets. Load before the candidate so an accidental remote fallback fails.
import net from "node:net";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import "./sqlite-read-fault.mjs";

const original = net.Socket.prototype.connect;
const allowed = host => host === undefined || host === "localhost" || host === "127.0.0.1" || host === "::1";
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === "object" ? first.host ?? first.hostname : typeof args[1] === "string" ? args[1] : undefined;
  // Unix/Windows IPC sockets do not have a network host.
  if (!allowed(host) && !(first && typeof first === "object" && first.path)) {
    const message = `E2E_EXTERNAL_EGRESS_BLOCKED: ${String(host)}`;
    if (process.env.BILI_E2E_EGRESS_LOG) appendFileSync(process.env.BILI_E2E_EGRESS_LOG, message + "\n");
    const error = Object.assign(new Error(message), { code: "E2E_EXTERNAL_EGRESS_BLOCKED" });
    throw error;
  }
  return original.apply(this, args);
};
syncBuiltinESMExports();
