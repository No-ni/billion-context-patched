// Valid synthetic 1x1 PNGs keep retention tests independent of image encoders.
import { deflateSync } from "node:zlib";

function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const payload = Buffer.concat([Buffer.from(type), body]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(body.length); tail.writeUInt32BE(crc(payload)); return Buffer.concat([head, payload, tail]);
}
export function imageUrl(rgb) {
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  const bytes = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, ...rgb]))), chunk("IEND", Buffer.alloc(0))]);
  return "data:image/png;base64," + bytes.toString("base64");
}
export function historicalImageMessages(url, marker) {
  return [{ role: "system", content: "You are the isolated local image-retention mock assistant." }, { role: "user", content: [{ type: "text", text: marker }, { type: "image_url", image_url: { url } }] }, { role: "assistant", content: "The local image has been presented in the earlier turn." }, { role: "user", content: "Continue the local task with the earlier image in history." }];
}
