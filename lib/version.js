const triple = (value) => {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
};

/** Same-version bug fixes are identified by a stable build hash and its creation time. */
export function hasPublishedUpdate(installed, published) {
  const a = triple(installed?.version);
  const b = triple(published?.version);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i += 1) {
    if (b[i] > a[i]) return true;
    if (b[i] < a[i]) return false;
  }
  const current = installed.patchBuild;
  const latest = published.patchBuild;
  if (!/^[a-f0-9]{64}$/.test(latest?.id ?? "") || latest.id === current?.id) return false;
  const latestTime = Date.parse(latest.createdAt);
  if (!Number.isFinite(latestTime)) return false;
  if (!current || !/^[a-f0-9]{64}$/.test(current.id ?? "")) return true;
  const currentTime = Date.parse(current.createdAt);
  return !Number.isFinite(currentTime) || latestTime > currentTime;
}
