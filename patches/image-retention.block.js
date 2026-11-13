// --- image retention: a picture is worth one look ---------------------------
// Every outbound request carries the whole transcript, so an image that was
// looked at once is paid for again on every later turn. After an image has
// crossed the wire successfully, the next request carries a one-line
// placeholder instead of the pixels; acp_read_original_image("<ref>") brings
// the original back when the model genuinely needs it again.
//
// The same pass shrinks what is still leaving, through whatever the host
// already ships: /usr/bin/sips on macOS, Windows PowerShell's System.Drawing on
// win32, ImageMagick on PATH anywhere else. Each backend is offered both a JPEG
// and a PNG encoding and the smaller one is kept. Without a usable encoder or
// enough byte savings, the original pixels are kept.
//
// Off switch: imageRetention:false in the config file, or BILI_IMAGE_RETENTION=0.

var BILI_RETENTION_SEEN_CAP = 400;
var BILI_RETENTION_SHRINK_CACHE_CAP = 16;
var BILI_RETENTION_VARIANT_CACHE_CAP = 16;
var BILI_RETENTION_TRIGGER_BYTES = 100 * 1024;
var BILI_RETENTION_KEEP_RATIO = 0.8;
var BILI_RETENTION_DEFAULT_MAX_DIM = 1200;
var BILI_RETENTION_SEEN_TEXT = "\u5df2\u770b\u8fc7\uFF0C\u540e\u7eed\u8bf7\u6c42\u4e0d\u518d\u91cd\u4f20";
var BILI_RETENTION_RESTORE_TEXT = "\uFF1B\u9700\u8981\u539f\u56fe\u65f6\u8c03\u7528 {ref}";
var biliRetentionShrinkCache = new Map;
var biliRetentionVariants = new Map;
var biliRetentionPendingByAttempt = new WeakMap;
var biliRetentionReceipts = new WeakMap;

function biliRetentionConfig() {
  try {
    const cfg = loadConfigFile();
    return isObj4(cfg) ? cfg : {};
  } catch (err) {
    return {};
  }
}

function biliRetentionFlag(key, envKey, dflt) {
  const raw = process.env[envKey];
  if (raw !== void 0) return !(raw === "0" || raw === "false" || raw === "off");
  const v = biliRetentionConfig()[key];
  return v === void 0 ? dflt : v !== false;
}

function biliRetentionEnabled() {
  return biliRetentionFlag("imageRetention", "BILI_IMAGE_RETENTION", true);
}

function biliRetentionKeepLastUser() {
  return biliRetentionFlag("imageRetentionKeepLastUser", "BILI_IMAGE_RETENTION_KEEP_LAST_USER", true);
}

function biliRetentionMaxDim() {
  const env = tIntLoose("BILI_IMAGE_RETENTION_MAX_DIM", void 0);
  if (Number.isInteger(env) && env >= 128) return env;
  const v = biliRetentionConfig().imageRetentionMaxDim;
  return Number.isInteger(v) && v >= 128 ? v : BILI_RETENTION_DEFAULT_MAX_DIM;
}

function biliRetentionHash(b64) {
  return hashContent(b64).slice(0, 32);
}

// --- what the session already looked at ------------------------------------

function biliRetentionSeen(session) {
  const set = new Set;
  try {
    const md = session && session.metadata;
    const list = md && Array.isArray(md.biliImageSeen) ? md.biliImageSeen : [];
    for (const h of list) if (typeof h === "string") set.add(h);
  } catch (err) {}
  return set;
}

function biliRetentionRemember(session, hashes) {
  if (!session || !Array.isArray(hashes) || hashes.length === 0) return;
  try {
    const md = session.metadata ?? (session.metadata = {});
    const list = Array.isArray(md.biliImageSeen) ? md.biliImageSeen.slice() : [];
    const known = new Set(list);
    let added = 0;
    for (const h of hashes) {
      if (typeof h !== "string" || known.has(h)) continue;
      known.add(h);
      list.push(h);
      added++;
    }
    if (added === 0) return;
    md.biliImageSeen = list.slice(-BILI_RETENTION_SEEN_CAP);
    if (typeof markDirty === "function") markDirty(session);
  } catch (err) {}
}

function biliRetentionAttempt(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") ? value : void 0;
}

function biliRetentionClearPending(attempt) {
  if (biliRetentionAttempt(attempt) === void 0) return;
  const previous = biliRetentionPendingByAttempt.get(attempt);
  if (previous !== void 0 && previous.receipt !== void 0) biliRetentionReceipts.delete(previous.receipt);
  biliRetentionPendingByAttempt.delete(attempt);
}

// A forward runs outside the session lock. Park its sightings on its own
// opaque attempt object, never on a shared session-id slot. A new retry only
// replaces this attempt's pending images and invalidates its old receipt.
function biliRetentionMarkPending(session, images, attempt) {
  if (!session || typeof session.id !== "string" || biliRetentionAttempt(attempt) === void 0) return;
  if (!Array.isArray(images) || images.length === 0) return;
  biliRetentionPendingByAttempt.set(attempt, { session: session, sessionId: session.id, images: images.slice() });
}

// Apply runs before the shedder. Only the pixels surviving the final plaintext
// wire body can be promoted on success; discarded or unknown replacements do
// not prove that their originals were seen. The opaque receipt snapshots this
// send and must be passed explicitly to its own successful-forward hook.
function biliRetentionFinalize(body, protocol, session, attempt) {
  if (!session || typeof session.id !== "string" || biliRetentionAttempt(attempt) === void 0) return;
  const pending = biliRetentionPendingByAttempt.get(attempt);
  if (pending === void 0) return;
  if (pending.receipt !== void 0) biliRetentionReceipts.delete(pending.receipt);
  try {
    if (pending.session !== session || pending.sessionId !== session.id) throw new Error("image finalization session does not match its attempt");
    if (typeof body !== "string") throw new Error("image finalization needs a plaintext body");
    const parsed = JSON.parse(body);
    if (!isObj4(parsed)) throw new Error("image finalization needs an object body");
    const wireCounts = new Map;
    for (const image of biliRetentionCollect(protocol, biliRetentionRequestBody(protocol, parsed))) {
      const hash = biliRetentionHash(image.b64);
      wireCounts.set(hash, (wireCounts.get(hash) || 0) + 1);
    }
    const groups = new Map;
    for (const image of pending.images) {
      let group = groups.get(image.wireHash);
      if (group === void 0) {
        group = [];
        groups.set(image.wireHash, group);
      }
      group.push(image);
    }
    const survivors = [];
    for (const [hash, group] of groups) {
      const remaining = wireCounts.get(hash) || 0;
      if (remaining === 0) continue;
      const originals = new Set(group.map(function (image) { return image.originalHash; }));
      // Different originals can resize to identical pixels. If some copies
      // were shed, the hash alone cannot identify the surviving original.
      if (originals.size > 1 && remaining < group.length) {
        survivors.push({ originalHash: hash, wireHash: hash });
      } else {
        for (const image of group) survivors.push(image);
      }
    }
    if (survivors.length === 0) {
      biliRetentionClearPending(attempt);
      return;
    }
    const receipt = {};
    pending.receipt = receipt;
    biliRetentionReceipts.set(receipt, { session: session, sessionId: session.id, images: survivors });
    return receipt;
  } catch (err) {
    biliRetentionClearPending(attempt);
  }
}

function biliRetentionCommit(sessionId, receipt) {
  if (typeof sessionId !== "string" || biliRetentionAttempt(receipt) === void 0) return;
  const accepted = biliRetentionReceipts.get(receipt);
  if (accepted === void 0 || accepted.sessionId !== sessionId || accepted.session.id !== sessionId) return;
  biliRetentionReceipts.delete(receipt);
  const hashes = [];
  for (const image of accepted.images) hashes.push(image.originalHash, image.wireHash);
  biliRetentionRemember(accepted.session, hashes);
}

// A retry may start from the already resized outbound copy. Remember its
// original identity without treating it as seen, and avoid resizing that copy
// twice under the same settings. Colliding aliases never guess an original.
function biliRetentionVariantKey(session, hash) {
  return session && typeof session.id === "string" ? JSON.stringify([session.id, hash]) : void 0;
}

function biliRetentionVariant(session, hash) {
  const key = biliRetentionVariantKey(session, hash);
  return key === void 0 ? void 0 : biliRetentionVariants.get(key);
}

function biliRetentionRememberVariant(session, wireHash, mediaType, maxDim, originalHash, originalMediaType, originalB64) {
  const key = biliRetentionVariantKey(session, wireHash);
  if (key === void 0) return;
  const previous = biliRetentionVariants.get(key);
  const ambiguous = previous !== void 0 && (previous.ambiguous || previous.originalHash !== originalHash);
  biliRetentionVariants.delete(key);
  biliRetentionVariants.set(key, {
    mediaType: mediaType,
    maxDim: maxDim,
    ambiguous: ambiguous,
    originalHash: ambiguous ? void 0 : originalHash,
    originalMediaType: ambiguous ? void 0 : originalMediaType,
    originalB64: ambiguous ? void 0 : originalB64
  });
  while (biliRetentionVariants.size > BILI_RETENTION_VARIANT_CACHE_CAP) {
    const oldest = biliRetentionVariants.keys().next().value;
    if (oldest === void 0 || oldest === key) break;
    biliRetentionVariants.delete(oldest);
  }
}

// --- shrinking what still goes out -----------------------------------------
// No dependency is installed for resizing, so the pass borrows whatever the
// host already ships: sips on macOS, Windows PowerShell's System.Drawing on
// win32, ImageMagick (magick/convert) wherever it is on PATH. The first
// backend that yields a file at or below the keep ratio wins; with none of
// them the pixels leave untouched and folding still works.

var biliRetentionBackendsCache;

function biliRetentionIsFile(p) {
  try {
    return require("node:fs").statSync(p).isFile();
  } catch (err) {
    return false;
  }
}

function biliRetentionPathBin(names, accept) {
  try {
    const path2 = require("node:path");
    const dirs = String(process.env.PATH || "").split(path2.delimiter);
    const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
    for (const dir of dirs) {
      if (dir === "") continue;
      for (const name of names) {
        for (const ext of exts) {
          const full = path2.join(dir, name + ext);
          if (biliRetentionIsFile(full) && (!accept || accept(full))) return full;
        }
      }
    }
  } catch (err) {}
  return null;
}

function biliRetentionPowerShellBin() {
  try {
    const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
    const path2 = require("node:path");
    const full = path2.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (biliRetentionIsFile(full)) return full;
  } catch (err) {}
  return biliRetentionPathBin(["powershell"]);
}

// Platform order, pure so the test can pin it without a Windows host.
function biliRetentionBackendOrder(platform) {
  if (platform === "darwin") return ["sips", "magick", "convert"];
  if (platform === "win32") return ["powershell", "magick", "convert"];
  return ["magick", "convert"];
}

function biliRetentionBackendBin(id) {
  if (id === "sips") return process.platform === "darwin" && biliRetentionIsFile("/usr/bin/sips") ? "/usr/bin/sips" : null;
  if (id === "powershell") return process.platform === "win32" ? biliRetentionPowerShellBin() : null;
  if (id === "magick" || id === "convert") return biliRetentionPathBin([id], function (bin) {
    // Windows also ships convert.exe for filesystem conversion. Only accept
    // an actual ImageMagick executable, and keep trying later PATH candidates.
    try {
      const version = require("node:child_process").execFileSync(bin, ["-version"], {
        timeout: 2500, windowsHide: true, encoding: "utf8", maxBuffer: 16384,
        stdio: ["ignore", "pipe", "ignore"]
      });
      return /\bImageMagick\b/.test(version);
    } catch (err) { return false; }
  });
  return null;
}

function biliRetentionBackends() {
  if (biliRetentionBackendsCache !== void 0) return biliRetentionBackendsCache;
  const out = [];
  for (const id of biliRetentionBackendOrder(process.platform)) {
    const bin = biliRetentionBackendBin(id);
    if (bin) out.push({ id: id, bin: bin });
  }
  biliRetentionBackendsCache = out;
  return out;
}

function biliRetentionExec(bin, args) {
  return new Promise(function (resolve) {
    try {
      require("node:child_process").execFile(bin, args, { timeout: 20000, windowsHide: true }, function (err) {
        resolve(err ? false : true);
      });
    } catch (err) {
      resolve(false);
    }
  });
}

function biliRetentionSourceExt(mediaType) {
  if (mediaType === "image/jpeg") return ".jpg";
  return ".png";
}

function biliRetentionPsQuote(value) {
  return "'" + String(value).split("'").join("''") + "'";
}

// One PowerShell process writes both candidates: System.Drawing decodes the
// source, HighQualityBicubic brings the long edge down to maxDim, JPEG carries
// quality 80 over a white matte (so a transparent PNG does not come out black),
// and the PNG twin keeps the alpha.
function biliRetentionPowerShellScript(src, jpg, png, maxDim) {
  return [
    "$ErrorActionPreference='Stop';",
    "Add-Type -AssemblyName System.Drawing;",
    "$src=[System.Drawing.Image]::FromFile(" + biliRetentionPsQuote(src) + ");",
    "$max=" + String(maxDim) + ";",
    "$w=[double]$src.Width;$h=[double]$src.Height;",
    "$s=[Math]::Min(1.0,$max/[Math]::Max($w,$h));",
    "$nw=[int][Math]::Max(1,[Math]::Round($w*$s));$nh=[int][Math]::Max(1,[Math]::Round($h*$s));",
    "$alpha=New-Object System.Drawing.Bitmap -ArgumentList $nw,$nh,([System.Drawing.Imaging.PixelFormat]::Format32bppArgb);",
    "$ga=[System.Drawing.Graphics]::FromImage($alpha);",
    "$ga.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;",
    "$ga.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality;",
    "$ga.Clear([System.Drawing.Color]::Transparent);",
    "$ga.DrawImage($src,0,0,$nw,$nh);",
    "$ga.Dispose();",
    "$alpha.Save(" + biliRetentionPsQuote(png) + ",[System.Drawing.Imaging.ImageFormat]::Png);",
    "$alpha.Dispose();",
    "$bmp=New-Object System.Drawing.Bitmap -ArgumentList $nw,$nh;",
    "$g=[System.Drawing.Graphics]::FromImage($bmp);",
    "$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic;",
    "$g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality;",
    "$g.Clear([System.Drawing.Color]::White);",
    "$g.DrawImage($src,0,0,$nw,$nh);",
    "$g.Dispose();",
    "$codec=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}|Select-Object -First 1;",
    "$q=[System.Drawing.Imaging.Encoder]::Quality;",
    "$ep=New-Object System.Drawing.Imaging.EncoderParameters -ArgumentList 1;",
    "$ep.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList $q,([long]80);",
    "$bmp.Save(" + biliRetentionPsQuote(jpg) + ",$codec,$ep);",
    "$bmp.Dispose();$src.Dispose();"
  ].join(" ");
}

// Each backend becomes a list of steps; a step carries the files it writes so
// the caller only has to stat what a successful run claims to have produced.
function biliRetentionBackendSteps(backend, src, dir, maxDim) {
  const path2 = require("node:path");
  const jpg = path2.join(dir, "out.jpg");
  const png = path2.join(dir, "out.png");
  const dim = String(maxDim);
  const outJpg = { path: jpg, mime: "image/jpeg" };
  const outPng = { path: png, mime: "image/png" };
  if (backend.id === "sips") {
    return [
      { bin: backend.bin, args: ["-Z", dim, "-s", "format", "jpeg", "-s", "formatOptions", "80", src, "--out", jpg], outs: [outJpg] },
      { bin: backend.bin, args: ["-Z", dim, src, "--out", png], outs: [outPng] }
    ];
  }
  if (backend.id === "powershell") {
    return [{ bin: backend.bin, args: ["-NoProfile", "-NonInteractive", "-Command", biliRetentionPowerShellScript(src, jpg, png, maxDim)], outs: [outJpg, outPng] }];
  }
  const zoom = dim + "x" + dim + ">";
  return [
    { bin: backend.bin, args: [src, "-resize", zoom, "-quality", "80", jpg], outs: [outJpg] },
    { bin: backend.bin, args: [src, "-resize", zoom, png], outs: [outPng] }
  ];
}

async function biliRetentionShrinkOne(mediaType, b64, maxDim) {
  if (mediaType !== "image/png" && mediaType !== "image/jpeg") return null;
  const dims = decodeImageDims(b64);
  const origBytes = b64Bytes2(b64);
  const oversized = dims !== void 0 && Math.max(dims.w, dims.h) > maxDim;
  if (!oversized && origBytes <= BILI_RETENTION_TRIGGER_BYTES) return null;
  const backends = biliRetentionBackends();
  if (backends.length === 0) return null;
  let dir = null;
  try {
    const fsp = require("node:fs/promises");
    const os2 = require("node:os");
    const path2 = require("node:path");
    dir = await fsp.mkdtemp(path2.join(os2.tmpdir(), "bili-retention-"));
    const src = path2.join(dir, "in" + biliRetentionSourceExt(mediaType));
    await fsp.writeFile(src, Buffer.from(b64, "base64"));
    for (const backend of backends) {
      let best = null;
      for (const step of biliRetentionBackendSteps(backend, src, dir, maxDim)) {
        if (!(await biliRetentionExec(step.bin, step.args))) continue;
        for (const out of step.outs) {
          let size = 0;
          try {
            size = (await fsp.stat(out.path)).size;
          } catch (err) {
            continue;
          }
          if (!(size > 0)) continue;
          if (best === null || size < best.bytes) best = { path: out.path, mime: out.mime, bytes: size };
        }
      }
      if (best === null) continue;
      if (best.bytes > origBytes * BILI_RETENTION_KEEP_RATIO) continue;
      const outB64 = (await fsp.readFile(best.path)).toString("base64");
      const nd = decodeImageDims(outB64);
      return {
        base64: outB64,
        mime: best.mime,
        bytes: best.bytes,
        origBytes: origBytes,
        width: nd === void 0 ? void 0 : nd.w,
        height: nd === void 0 ? void 0 : nd.h
      };
    }
    return null;
  } catch (err) {
    return null;
  } finally {
    if (dir !== null) {
      try {
        const path2 = require("node:path");
        const tempRoot = path2.resolve(require("node:os").tmpdir()) + path2.sep;
        if (!path2.resolve(dir).startsWith(tempRoot) || !path2.basename(dir).startsWith("bili-retention-")) {
          throw new Error("refusing image cleanup outside its temporary directory");
        }
        await require("node:fs/promises").rm(dir, { recursive: true, force: true });
      } catch (err) {}
    }
  }
}

function biliRetentionShrink(mediaType, b64, maxDim) {
  if (biliRetentionBackends().length === 0) return Promise.resolve(null);
  if (maxDim === void 0) maxDim = biliRetentionMaxDim();
  const key = biliRetentionHash(b64) + ":" + mediaType + ":" + maxDim;
  let pending = biliRetentionShrinkCache.get(key);
  if (pending === void 0) {
    pending = biliRetentionShrinkOne(mediaType, b64, maxDim);
    biliRetentionShrinkCache.set(key, pending);
    while (biliRetentionShrinkCache.size > BILI_RETENTION_SHRINK_CACHE_CAP) {
      const oldest = biliRetentionShrinkCache.keys().next().value;
      if (oldest === void 0 || oldest === key) break;
      biliRetentionShrinkCache.delete(oldest);
    }
  }
  return pending;
}

// --- finding the images in a request body ----------------------------------
// Mirrors the vendor's own occurrence walk, minus its two exemptions: an image
// handed back by acp_read_original_image is exactly the kind of picture that
// should get one look, not a permanent resident.

function biliRetentionPushAnthropic(occ, parts, entryIndex) {
  if (!Array.isArray(parts)) return;
  parts.forEach(function (part, pos) {
    if (!isObj4(part) || part.type !== "image") return;
    const src = part.source;
    if (!isObj4(src) || src.type !== "base64" || typeof src.data !== "string" || src.data.length === 0) return;
    const mediaType = typeof src.media_type === "string" ? src.media_type : "image/png";
    occ.push({
      entryIndex: entryIndex,
      b64: src.data,
      mediaType: mediaType,
      applyImage: function (b641, mime) {
        src.data = b641;
        src.media_type = mime;
      },
      applyArchive: function (note) {
        parts[pos] = { type: "text", text: note };
      }
    });
  });
}

function biliRetentionGoogleNoteWriter(toolResponse) {
  const previous = toolResponse.response;
  const response = isObj4(previous) ? { ...previous } : previous === void 0 ? {} : { output: previous };
  toolResponse.response = response;
  // Google can select output/error as the effective function result. Keep
  // the notes inside that value, rather than in an ignored sibling field.
  const field = Object.prototype.hasOwnProperty.call(response, "output") ? "output" : Object.prototype.hasOwnProperty.call(response, "error") ? "error" : void 0;
  if (field !== void 0 && typeof response[field] === "string") {
    return function (note) { response[field] += "\n" + note; };
  }
  let target = response;
  if (field !== void 0) {
    const value = response[field];
    if (Array.isArray(value)) {
      const output = value.slice();
      response[field] = output;
      return function (note) { output.push(note); };
    }
    target = isObj4(value) ? { ...value } : { biliOriginalValue: value };
    response[field] = target;
  }
  let notesKey = "biliImageNotes";
  while (Object.prototype.hasOwnProperty.call(target, notesKey)) notesKey = "_" + notesKey;
  target[notesKey] = [];
  return function (note) { target[notesKey].push(note); };
}

function biliRetentionPushGoogle(occ, parts, entryIndex, toolResponse) {
  if (!Array.isArray(parts)) return;
  let writeNote;
  parts.forEach(function (part) {
    if (!isObj4(part)) return;
    const inline = part.inlineData;
    if (isObj4(inline) && typeof inline.data === "string" && inline.data.length > 0) {
      const mediaType = typeof inline.mimeType === "string" ? inline.mimeType : "image/png";
      // inlineData is also Google's carrier for audio, video and documents.
      // Missing MIME keeps the historical image/png fallback.
      if (/^image\//i.test(mediaType)) {
        occ.push({
          entryIndex: entryIndex,
          b64: inline.data,
          mediaType: mediaType,
          applyImage: function (b641, mime) {
            inline.data = b641;
            inline.mimeType = mime;
          },
          applyArchive: function (note) {
            const pos = parts.indexOf(part);
            if (pos === -1) return;
            if (!toolResponse) {
              parts[pos] = { text: note };
              return;
            }
            // FunctionResponse.parts only accepts media parts. Put the text
            // in its JSON response and leave every unrelated result intact.
            parts.splice(pos, 1);
            if (parts.length === 0) delete toolResponse.parts;
            if (writeNote === void 0) writeNote = biliRetentionGoogleNoteWriter(toolResponse);
            writeNote(note);
          }
        });
      }
    }
    const response = part.functionResponse;
    if (!toolResponse && isObj4(response) && Array.isArray(response.parts)) {
      biliRetentionPushGoogle(occ, response.parts, entryIndex, response);
    }
  });
}

// v1internal wraps the native Google request before loop serialization. Work
// on the inner request while serializing the original outer graph, preserving
// project/model/request-id metadata and all other envelope fields.
function biliRetentionRequestBody(protocol, body) {
  if (protocol === "google" && !Array.isArray(body.contents) && isObj4(body.request) && Array.isArray(body.request.contents)) return body.request;
  return body;
}

function biliRetentionCollect(protocol, body) {
  const occ = [];
  if (protocol === "google") {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    contents.forEach(function (content, entryIndex) {
      if (!isObj4(content) || !Array.isArray(content.parts)) return;
      biliRetentionPushGoogle(occ, content.parts, entryIndex);
    });
    return occ;
  }
  if (protocol === "responses") {
    const input = Array.isArray(body.input) ? body.input : [];
    input.forEach(function (item, entryIndex) {
      if (!isObj4(item)) return;
      const key = item.type === "message" || item.type === void 0 && typeof item.role === "string" ? "content" : item.type === "function_call_output" || item.type === "custom_tool_call_output" ? "output" : void 0;
      if (key === void 0 || !Array.isArray(item[key])) return;
      const parts = item[key];
      parts.forEach(function (part, pos) {
        if (!isObj4(part) || part.type !== "input_image" || typeof part.image_url !== "string") return;
        const parsed = parseDataUrl(part.image_url);
        if (!parsed) return;
        occ.push({
          entryIndex: entryIndex,
          b64: parsed.base64,
          mediaType: parsed.mediaType,
          applyImage: function (b641, mime) {
            part.image_url = dataUrl(mime, b641);
          },
          applyArchive: function (note) {
            parts[pos] = { type: "input_text", text: note };
          }
        });
      });
    });
    return occ;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  messages.forEach(function (message, entryIndex) {
    if (!isObj4(message) || !Array.isArray(message.content)) return;
    const content = message.content;
    if (protocol === "anthropic") biliRetentionPushAnthropic(occ, content, entryIndex);
    content.forEach(function (part, pos) {
      if (!isObj4(part)) return;
      if (protocol === "openai") {
        if (part.type !== "image_url") return;
        const imageUrl = part.image_url;
        const url = typeof imageUrl === "string" ? imageUrl : isObj4(imageUrl) && typeof imageUrl.url === "string" ? imageUrl.url : void 0;
        if (typeof url !== "string") return;
        const parsed = parseDataUrl(url);
        if (!parsed) return;
        occ.push({
          entryIndex: entryIndex,
          b64: parsed.base64,
          mediaType: parsed.mediaType,
          applyImage: function (b641, mime) {
            part.image_url = typeof imageUrl === "string" ? dataUrl(mime, b641) : Object.assign({}, imageUrl, { url: dataUrl(mime, b641) });
          },
          applyArchive: function (note) {
            content[pos] = { type: "text", text: note };
          }
        });
        return;
      }
      if (part.type === "tool_result" && Array.isArray(part.content)) biliRetentionPushAnthropic(occ, part.content, entryIndex);
    });
  });
  return occ;
}

// The upload the user is looking at right now: the final entry, a plain user
// turn. Tool results never qualify, so a screenshot returned by a tool is
// folded like any other image.
function biliRetentionFreshUpload(protocol, body) {
  if (protocol === "google") {
    const contents = Array.isArray(body.contents) ? body.contents : [];
    const last = contents[contents.length - 1];
    if (!isObj4(last) || last.role !== "user") return -1;
    if (Array.isArray(last.parts) && last.parts.some(function (part) {
      return isObj4(part) && isObj4(part.functionResponse);
    })) return -1;
    return contents.length - 1;
  }
  if (protocol === "responses") {
    const input = Array.isArray(body.input) ? body.input : [];
    const last = input[input.length - 1];
    return isObj4(last) && (last.type === "message" || last.type === void 0) && last.role === "user" ? input.length - 1 : -1;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const last = messages[messages.length - 1];
  if (!isObj4(last) || last.role !== "user") return -1;
  if (protocol === "anthropic" && Array.isArray(last.content) && last.content.some(function (part) {
    return isObj4(part) && part.type === "tool_result";
  })) return -1;
  return messages.length - 1;
}

function biliRetentionToolsArmed(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) {
    if (!isObj4(tool)) continue;
    const name = typeof tool.name === "string" ? tool.name : isObj4(tool.function) && typeof tool.function.name === "string" ? tool.function.name : void 0;
    if (name === READ_ORIGINAL_IMAGE_TOOL_NAME) return true;
    if (Array.isArray(tool.functionDeclarations) && tool.functionDeclarations.some(function (declaration) {
      return isObj4(declaration) && declaration.name === READ_ORIGINAL_IMAGE_TOOL_NAME;
    })) return true;
  }
  return false;
}

function biliRetentionNote(origMediaType, b64, ref, armed) {
  const mime = String(origMediaType || "image/png").replace(/^image\//i, "");
  const bits = [];
  if (mime) bits.push(mime);
  const dims = decodeImageDims(b64);
  if (dims) bits.push(dims.w + "x" + dims.h);
  if (ref) bits.push(ref);
  let text = "[image: " + bits.join(" ") + " " + BILI_RETENTION_SEEN_TEXT;
  if (ref && armed) text += BILI_RETENTION_RESTORE_TEXT.replace("{ref}", READ_ORIGINAL_IMAGE_TOOL_NAME + "(\"" + ref + "\")");
  return text + "]";
}

// --- the pass ---------------------------------------------------------------

async function biliRetentionApply(body, protocol, session, ctx) {
  const noop = { body: body, changed: false, folded: 0, shrunk: 0 };
  const attempt = biliRetentionAttempt(ctx && ctx.attempt);
  try {
    // A failed attempt's pixels cannot be credited to a later text-only or
    // disabled retry that happens to succeed for the same forward.
    biliRetentionClearPending(attempt);
    // An uninstrumented send has no receipt owner: preserve its pixels and
    // make no session-id guess about which request might later succeed.
    if (attempt === void 0) return noop;
    if (!biliRetentionEnabled()) return noop;
    if (typeof body !== "string" || body.length < 256) return noop;
    if (body.indexOf("base64") === -1 && body.indexOf("inlineData") === -1) return noop;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return noop;
    }
    if (!isObj4(parsed)) return noop;
    const requestBody = biliRetentionRequestBody(protocol, parsed);
    const occurrences = biliRetentionCollect(protocol, requestBody);
    if (occurrences.length === 0) return noop;
    const seen = biliRetentionSeen(session);
    const armed = biliRetentionToolsArmed(requestBody);
    const fresh = biliRetentionKeepLastUser() ? biliRetentionFreshUpload(protocol, requestBody) : -1;
    const maxDim = biliRetentionMaxDim();
    const images = [];
    let changed = false;
    let folded = 0;
    let shrunk = 0;
    for (const occurrence of occurrences) {
      const hashInput = biliRetentionHash(occurrence.b64);
      const variant = biliRetentionVariant(session, hashInput);
      const knownOrigin = variant !== void 0 && !variant.ambiguous;
      const origB64 = knownOrigin ? variant.originalB64 : occurrence.b64;
      const origMediaType = knownOrigin ? variant.originalMediaType : occurrence.mediaType;
      const hashOrig = knownOrigin ? variant.originalHash : hashInput;
      const alreadyResized = variant !== void 0 && variant.mediaType === occurrence.mediaType && variant.maxDim === maxDim;
      const isFresh = occurrence.entryIndex === fresh;
      let ref;
      try {
        ref = session === void 0 ? void 0 : await refForItemBytes(session, origMediaType, origB64);
        if (typeof ref !== "string" || !/^m\d{5,}$/.test(ref)) ref = void 0;
      } catch (err) {
        ref = void 0;
      }
      // Already looked at: fold first, so a doomed picture never pays for a
      // resize that would be thrown away in the same pass. No recoverable ref
      // means keeping the pixels, rather than replacing them with a dead end.
      if (ref && !isFresh && (seen.has(hashOrig) || seen.has(hashInput))) {
        occurrence.applyArchive(biliRetentionNote(origMediaType, origB64, ref, armed));
        folded++;
        changed = true;
        continue;
      }
      const smaller = alreadyResized ? null : await biliRetentionShrink(occurrence.mediaType, occurrence.b64, maxDim);
      let hashWire = hashInput;
      if (smaller !== null) {
        hashWire = biliRetentionHash(smaller.base64);
        biliRetentionRememberVariant(session, hashWire, smaller.mime, maxDim, hashOrig, origMediaType, origB64);
        const wireVariant = biliRetentionVariant(session, hashWire);
        if (ref && !isFresh && seen.has(hashWire) && wireVariant !== void 0 && !wireVariant.ambiguous && wireVariant.originalHash === hashOrig) {
          occurrence.applyArchive(biliRetentionNote(origMediaType, origB64, ref, armed));
          folded++;
          changed = true;
          continue;
        }
        occurrence.applyImage(smaller.base64, smaller.mime);
        shrunk++;
        changed = true;
      }
      images.push({ originalHash: hashOrig, wireHash: hashWire });
    }
    biliRetentionMarkPending(session, images, attempt);
    if (!changed) return noop;
    const next = JSON.stringify(parsed);
    return { body: next, changed: true, folded: folded, shrunk: shrunk };
  } catch (err) {
    return noop;
  }
}
