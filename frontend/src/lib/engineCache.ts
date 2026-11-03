export interface EngineDescriptor {
  entry_url: string;
  stylesheet_urls: string[];
  polyfill_urls: string[];
}
export interface PreparedEngine {
  source: string;
  resources: string[];
  revision: string;
}
// Bump whenever the AST bridge or its runtime contract changes.
export const ENGINE_ADAPTER_VERSION = "native-bridge-v7";
export async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((n) => n.toString(16).padStart(2, "0")).join("");
}
export async function cachedEngine(descriptor: EngineDescriptor, storage: {
  read(key: string): Promise<string | null>;
  write(key: string, data: string): Promise<void>;
}, build: () => Promise<PreparedEngine>, routingScope = ""): Promise<{ engine: PreparedEngine; reused: boolean }> {
  const identity = `${ENGINE_ADAPTER_VERSION}:${routingScope}:${JSON.stringify(descriptor)}`;
  const key = `prepared-engine-${await sha256(identity)}`;
  // Only hashed entrypoints promise immutability. Unversioned dev entrypoints
  // must still be rebuilt/revalidated rather than becoming a permanent cache.
  const immutable = /\/StoryPlayer\.[a-z\d_-]+\.js$/i.test(descriptor.entry_url);
  if (immutable) {
    try {
      const raw = await storage.read(key);
      if (raw) {
        const saved = JSON.parse(raw);
        const engine = saved.engine as PreparedEngine;
        if (saved.identity === identity && typeof engine?.source === "string"
          && /^[a-f\d]{64}$/.test(engine.revision) && Array.isArray(engine.resources)
          && engine.resources.includes(descriptor.entry_url)
          && saved.digest === await sha256(JSON.stringify(engine))) {
          return { engine, reused: true };
        }
      }
    } catch { /* A damaged/adapted cache must never prevent rebuilding. */ }
  }
  const engine = await build();
  if (immutable) {
    await storage.write(key, JSON.stringify({ identity, digest: await sha256(JSON.stringify(engine)), engine })).catch(() => {});
  }
  return { engine, reused: false };
}
