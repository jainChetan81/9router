import crypto from "node:crypto";

/** Return an opaque fingerprint for the API key used by OpenCode Go requests. */
export function getOpenCodeGoCredentialFingerprint(connection) {
  const apiKey = typeof connection?.apiKey === "string" ? connection.apiKey : "";
  return crypto.createHash("sha256").update("opencode-go\0").update(apiKey).digest("hex");
}
