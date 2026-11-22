// <bili-image-restore>
// A: a DSH host image offload ("[image omitted to fit request image limits; sha256:...]")
// is replaced, right before the send, by the exact text+image parts this session
// sent before the offload, so the outgoing prefix stays byte-identical and the
// provider cache keeps matching. Nothing is learned from failures and no
// placeholder is ever rewritten into the stored history.
// B: an upstream 413 that names an upload/body size limit is not a context
// overflow. The proxy forces one bounded compression round and re-sends once.
const __BILI_IMAGE_RESTORE_PARTS = 96;
const __BILI_IMAGE_RESTORE_BYTES = 64 * 1024 * 1024;
const __BILI_IMAGE_RESTORE_SESSIONS = 64;
const __BILI_IMAGE_RESTORE_TOTAL_BYTES = 256 * 1024 * 1024;
const __BILI_IMAGE_OFFLOAD_MARK = "image omitted to fit request image limits;";
const __BILI_IMAGE_HANDLE_MARK = "; request preview ";
const __biliImageRestoreCaches = new Map();

function __biliImageRestoreEnabled() {
  try {
    const raw = process.env.BILI_IMAGE_RESTORE;
    if (raw !== void 0) return !(raw === "0" || raw === "false" || raw === "off");
    const value = loadConfigFile().imageRestoreHostOffload;
    return !(value === false || value === 0 || value === "0" || value === "false" || value === "off");
  } catch { return true }
}

function __biliImageRestoreCache(sessionId) {
  const existing = __biliImageRestoreCaches.get(sessionId);
  if (existing !== void 0) {
    // Refresh the eviction order: the session used right now is the last one a
    // global byte-budget trim may drop.
    __biliImageRestoreCaches.delete(sessionId);
    __biliImageRestoreCaches.set(sessionId, existing);
    return existing;
  }
  const cache = { parts: new Map(), order: [], bytes: 0, announced: false };
  __biliImageRestoreCaches.set(sessionId, cache);
  while (__biliImageRestoreCaches.size > __BILI_IMAGE_RESTORE_SESSIONS) {
    const oldest = __biliImageRestoreCaches.keys().next();
    if (oldest.done) break;
    __biliImageRestoreCaches.delete(oldest.value);
  }
  return cache;
}

function __biliImagePartBytes(image) {
  try { return JSON.stringify(image).length } catch { return 0 }
}

function __biliDropRestorePart(cache, key) {
  const entry = cache.parts.get(key);
  if (entry === void 0) return;
  cache.parts.delete(key);
  cache.bytes -= entry.bytes;
  if (cache.bytes < 0) cache.bytes = 0;
}

function __biliRememberRestorePart(cache, key, handle, image, content) {
  const bytes = __biliImagePartBytes(image);
  const known = cache.parts.get(key);
  if (known !== void 0) {
    cache.bytes += bytes - known.bytes;
    cache.parts.set(key, { handle: handle, image: image, content: content, bytes: bytes });
    return;
  }
  cache.parts.set(key, { handle: handle, image: image, content: content, bytes: bytes });
  cache.order.push(key);
  cache.bytes += bytes;
  while (cache.order.length > __BILI_IMAGE_RESTORE_PARTS || cache.bytes > __BILI_IMAGE_RESTORE_BYTES) {
    const oldest = cache.order.shift();
    if (oldest === void 0) break;
    __biliDropRestorePart(cache, oldest);
  }
  __biliTrimRestoreCaches();
}

function __biliRestoreCacheBytes() {
  let total = 0;
  for (const cache of __biliImageRestoreCaches.values()) total += cache.bytes;
  return total;
}

function __biliTrimRestoreCaches() {
  while (__biliRestoreCacheBytes() > __BILI_IMAGE_RESTORE_TOTAL_BYTES) {
    const oldest = __biliImageRestoreCaches.keys().next();
    if (oldest.done) break;
    __biliImageRestoreCaches.delete(oldest.value);
  }
}

function __biliSha256Token(text) {
  const at = text.indexOf("sha256:");
  if (at === -1) return null;
  const token = text.slice(at + 7, at + 71);
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

function __biliIsRequestImagePart(part) {
  if (part === null || typeof part !== "object" || Array.isArray(part)) return false;
  if (part.type === "image_url" || part.type === "input_image" || part.type === "image") return true;
  if (part.inlineData !== null && typeof part.inlineData === "object") return true;
  if (part.inline_data !== null && typeof part.inline_data === "object") return true;
  return false;
}

function __biliWalkArrays(root, visit) {
  const stack = [root];
  let nodes = 0;
  while (stack.length > 0) {
    if (++nodes > 200000) return;
    const node = stack.pop();
    if (Array.isArray(node)) {
      visit(node);
      for (const item of node) if (item !== null && typeof item === "object") stack.push(item);
    } else if (node !== null && typeof node === "object") {
      for (const key in node) {
        const value = node[key];
        if (value !== null && typeof value === "object") stack.push(value);
      }
    }
  }
}

function __biliWalkObjects(root, visit) {
  const stack = [root];
  let nodes = 0;
  while (stack.length > 0) {
    if (++nodes > 200000) return;
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (Array.isArray(node)) {
      for (const item of node) if (item !== null && typeof item === "object") stack.push(item);
      continue;
    }
    visit(node);
    for (const key in node) {
      const value = node[key];
      if (value !== null && typeof value === "object") stack.push(value);
    }
  }
}

// The OpenAI Chat path joins all-text message content into one string before
// the host offloads an image. A placeholder inside that string can only be
// restored when the surrounding text proves it is the same message the cached
// array came from; otherwise the placeholder stays untouched.
function __biliStripAcpTags(text) {
  // The accelerator prefixes text blocks with per-message ACP refs. A message
  // whose content changed gets a fresh ref, so the refs are not part of the
  // image identity and are ignored when matching the surrounding text.
  return text.replace(/<acp\b[^>]*>[\s\S]*?<\/acp>\s*/g, "");
}

function __biliRestoreStringContent(cache, protocol, text) {
  const pattern = /\[image omitted to fit request image limits;[^\]]*?sha256:([0-9a-f]{64})[^\]]*\]/g;
  const matches = [];
  let match;
  while ((match = pattern.exec(text)) !== null) matches.push({ text: match[0], token: match[1] });
  if (matches.length === 0) return null;
  if (text.split(__BILI_IMAGE_OFFLOAD_MARK).length - 1 !== matches.length) return null;
  let content = null;
  const handles = new Set();
  const entries = [];
  for (const item of matches) {
    const entry = cache.parts.get(protocol + "|" + item.token);
    if (entry === void 0 || !Array.isArray(entry.content)) return null;
    if (content === null) content = entry.content;
    else if (content !== entry.content) return null;
    entries.push(entry);
    if (entry.handle !== null && typeof entry.handle === "object" && typeof entry.handle.text === "string") handles.add(entry.handle.text);
  }
  let plain = text;
  for (const item of matches) plain = plain.replace(item.text, "");
  const textParts = [];
  let images = 0;
  for (const part of content) {
    if (part === null || typeof part !== "object") continue;
    if (typeof part.text === "string") textParts.push(part.text);
    if (__biliIsRequestImagePart(part)) images += 1;
  }
  if (images !== matches.length) return null;
  if (__biliStripAcpTags(plain) !== __biliStripAcpTags(textParts.filter(part => !handles.has(part)).join(""))) return null;
  // Rebuild around the placeholder positions so the current surrounding text
  // (including a fresh ACP ref) stays in place; only the retired image and its
  // handle are put back from the captured array.
  const rebuilt = [];
  let rest = text;
  for (let i = 0; i < matches.length; i++) {
    const at = rest.indexOf(matches[i].text);
    if (at < 0) return null;
    const before = rest.slice(0, at);
    if (before.length > 0) rebuilt.push({ type: "text", text: before });
    rebuilt.push(entries[i].handle, entries[i].image);
    rest = rest.slice(at + matches[i].text.length);
  }
  if (rest.length > 0) rebuilt.push({ type: "text", text: rest });
  return rebuilt;
}

function __biliRestoreStringMessages(parsed, cache, protocol) {
  let restored = 0;
  let missing = 0;
  __biliWalkObjects(parsed, function (node) {
    if (typeof node.content !== "string" || node.content.indexOf(__BILI_IMAGE_OFFLOAD_MARK) === -1) return;
    const content = __biliRestoreStringContent(cache, protocol, node.content);
    if (content === null) { missing += 1; return }
    node.content = content.slice();
    for (const part of content) if (__biliIsRequestImagePart(part)) restored += 1;
  });
  return { restored: restored, missing: missing };
}

function __biliCaptureRequestImages(parsed, protocol, sessionId) {
  const cache = __biliImageRestoreCache(sessionId);
  __biliWalkArrays(parsed, function (array2) {
    for (let i = 0; i < array2.length; i++) {
      const part = array2[i];
      if (part === null || typeof part !== "object" || typeof part.text !== "string") continue;
      if (part.text.length < 48 || part.text.indexOf(__BILI_IMAGE_HANDLE_MARK) === -1) continue;
      const token = __biliSha256Token(part.text);
      if (token === null) continue;
      const image = __biliIsRequestImagePart(array2[i + 1]) ? array2[i + 1] : __biliIsRequestImagePart(array2[i - 1]) ? array2[i - 1] : null;
      if (image === null) continue;
      __biliRememberRestorePart(cache, protocol + "|" + token, part, image, array2.slice());
    }
  });
}

function __biliRestoreRequestImages(parsed, protocol, sessionId) {
  const cache = __biliImageRestoreCaches.get(sessionId);
  if (cache === void 0) return { restored: 0, missing: 0 };
  let restored = 0;
  let missing = 0;
  __biliWalkArrays(parsed, function (array2) {
    for (let i = 0; i < array2.length; i++) {
      const part = array2[i];
      if (part === null || typeof part !== "object" || typeof part.text !== "string") continue;
      if (part.text.indexOf(__BILI_IMAGE_OFFLOAD_MARK) === -1) continue;
      const token = __biliSha256Token(part.text);
      const entry = token === null ? void 0 : cache.parts.get(protocol + "|" + token);
      if (entry === void 0) { missing += 1; continue }
      array2.splice(i, 1, entry.handle, entry.image);
      i += 1;
      restored += 1;
    }
  });
  const strings = __biliRestoreStringMessages(parsed, cache, protocol);
  restored += strings.restored;
  missing += strings.missing;
  return { restored: restored, missing: missing };
}

function __biliRestoreHostOffloads(body, prepared, log) {
  try {
    if (typeof body !== "string" || body.length < 256) return body;
    const hasHandle = body.indexOf(__BILI_IMAGE_HANDLE_MARK) !== -1;
    const hasOffload = body.indexOf(__BILI_IMAGE_OFFLOAD_MARK) !== -1;
    if (!hasHandle && !hasOffload) return body;
    const session = prepared === null || prepared === void 0 ? void 0 : prepared.session;
    const protocol = prepared !== null && prepared !== void 0 && typeof prepared.protocol === "string" ? prepared.protocol : "";
    if (session === void 0 || session === null || typeof session.id !== "string" || protocol === "") return body;
    if (!__biliImageRestoreEnabled()) return body;
    const parsed = JSON.parse(body);
    if (hasHandle) __biliCaptureRequestImages(parsed, protocol, session.id);
    if (!hasOffload) return body;
    const outcome = __biliRestoreRequestImages(parsed, protocol, session.id);
    if (outcome.restored === 0) {
      if (outcome.missing > 0) log("debug", "[" + session.id + "] [image-restore] " + outcome.missing + " host image placeholder(s) had no captured wire bytes; left as text");
      return body;
    }
    const next = JSON.stringify(parsed);
    const cache = __biliImageRestoreCaches.get(session.id);
    const first = cache !== void 0 && cache.announced !== true;
    if (cache !== void 0) cache.announced = true;
    log(first ? "info" : "debug", "[" + session.id + "] [image-restore] put " + outcome.restored + " host-offloaded image(s) back on the wire with their previous bytes" + (outcome.missing > 0 ? " (" + outcome.missing + " placeholder(s) stayed text)" : "") + " \u2014 the prefix stays byte-identical, so the provider cache keeps matching");
    return next;
  } catch (error) {
    try { log("warn", "[image-restore] this request kept its text placeholders: " + (error !== null && error !== void 0 && error.message ? error.message : String(error))); } catch {}
    return body;
  }
}

function __biliUploadLimitReject(status, bodyText) {
  if (status !== 413 || typeof bodyText !== "string" || bodyText.length === 0) return false;
  return /(?:upload[_\s-]?limit|upload size|entity too large|payload too large|request body (?:is )?too large|body too large|content too large|maximum upload|exceeds the (?:maximum )?(?:upload|body|request) (?:size|limit)|\u8bf7\u6c42\u4f53[^\uff0c\u3002\uff1b,;]{0,12}(?:\u8fc7\u5927|\u8d85\u9650|\u8d85\u8fc7|\u592a\u957f)|\u4e0a\u4f20[^\uff0c\u3002\uff1b,;]{0,12}(?:\u5927\u5c0f|\u9650\u5236|\u8d85\u9650|\u8fc7\u5927)|\u8d85\u8fc7[^\uff0c\u3002\uff1b,;]{0,12}(?:\u4e0a\u4f20|\u8bf7\u6c42\u4f53)(?:\u5927\u5c0f|\u9650\u5236)?)/i.test(bodyText);
}

function __biliUploadRefoldTarget(body, window, lastInputTokens, ratio) {
  const limit = Number.isFinite(window) && window > 0 ? Math.floor(window) : 0;
  const estimated = Math.max(1, Math.floor((typeof body === "string" ? Buffer.byteLength(body) : 0) / 4));
  let base = estimated;
  if (limit > 0 && base > limit) base = limit;
  const billed = Number.isFinite(lastInputTokens) && lastInputTokens > 0 ? Math.floor(lastInputTokens) : 0;
  if (billed > 0 && billed < base) base = billed;
  let target = Math.floor(base * ratio);
  if (limit > 0 && target >= limit) target = limit - 1;
  return Math.max(1024, target);
}
// </bili-image-restore>
