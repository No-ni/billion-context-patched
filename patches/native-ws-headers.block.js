// <bili-native-ws-headers begin>
function mergeWsInitHeaders(arg, extra) {
  if (extra === undefined || Object.keys(extra).length === 0) return arg;
  if (arg === undefined || arg === null) return { headers: { ...extra } };
  if (typeof arg === "string" || Array.isArray(arg)) return { protocols: arg, headers: { ...extra } };
  if (typeof arg !== "object") return arg;
  const init = { ...arg };
  const host = init.headers;
  if (host === undefined || host === null) {
    init.headers = { ...extra };
  } else if (host instanceof Headers || Array.isArray(host) || typeof host === "object") {
    // Headers.set replaces every case variant and duplicate of the stamp.
    // Keep the host's supported container shape and leave its object untouched.
    const headers = new Headers(host);
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
    init.headers = host instanceof Headers ? headers
      : Array.isArray(host) ? [...headers] : Object.fromEntries(headers);
  } else {
    return arg;
  }
  return init;
}
// <bili-native-ws-headers end>
