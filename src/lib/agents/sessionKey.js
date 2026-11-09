import { createHash } from "node:crypto";

const MAX_RAW_SESSION_LENGTH = 4096;

/**
 * Hash a raw session identity exactly as requestDetail.js does.
 */
export function sessionKey(rawSession) {
  try {
    if (typeof rawSession !== "string" || rawSession.length === 0 || rawSession.length > MAX_RAW_SESSION_LENGTH) return null;
    return createHash("sha256").update(String(rawSession)).digest("hex").slice(0, 12);
  } catch {
    return null;
  }
}

