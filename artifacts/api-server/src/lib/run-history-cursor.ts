type HistoryCursor =
  | { v: 1; at: string; id: string }
  | { v: 2; at: string; id: string; filterHash: string };

export function encodeHistoryCursor(at: string, id: string, filterHash?: string): string {
  const value = filterHash === undefined
    ? { v: 1, at, id }
    : { v: 2, at, id, filterHash };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeHistoryCursor(value: string): HistoryCursor {
  if (value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid history cursor");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid history cursor");
  }
  if (!decoded || typeof decoded !== "object") throw new Error("Invalid history cursor");
  const cursor = decoded as Record<string, unknown>;
  if (
    (cursor.v !== 1 && cursor.v !== 2) || typeof cursor.at !== "string" || typeof cursor.id !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.at) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id) ||
    (cursor.v === 2 && (typeof cursor.filterHash !== "string" || !/^[0-9a-f]{64}$/.test(cursor.filterHash)))
  ) throw new Error("Invalid history cursor");
  const milliseconds = cursor.at.slice(0, 23) + "Z";
  const date = new Date(milliseconds);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== milliseconds) {
    throw new Error("Invalid history cursor");
  }
  // Preserve all six PostgreSQL fractional digits, not a JS Date's three.
  return cursor.v === 2
    ? { v: 2, at: cursor.at, id: cursor.id, filterHash: cursor.filterHash as string }
    : { v: 1, at: cursor.at, id: cursor.id };
}
