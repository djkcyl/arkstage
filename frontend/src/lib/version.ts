import { getVersion } from "@tauri-apps/api/app";

// App version + update check. `current` comes from the Tauri app metadata. `latest`
// is checked jsDelivr-first (reachable in CN), GitHub API as fallback. jsDelivr's
// tag/packages API 502s for this repo, so jsd reads package.json off the CDN's
// master branch ref — its `version` is bumped to the latest release on every
// release (see CLAUDE.md), so it doubles as a CN-reachable "latest version" source.

export const REPO = "djkcyl/arkstage";
export const GITHUB_URL = `https://github.com/${REPO}`;
export const PRTS_URL = "https://prts.wiki";

export interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
  channel: "jsd" | "github";
  /** Release page to open so the user can download + install. */
  url: string;
}

const norm = (v: string) => v.replace(/^v/i, "").trim();

/** Compare dotted versions; >0 if a newer than b. */
function cmp(a: string, b: string): number {
  const pa = norm(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = norm(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

async function latestViaJsd(): Promise<string> {
  // jsDelivr's packages/resolve API 502s for this repo, but the CDN's branch refs
  // work. master's package.json `version` always equals the latest release (we bump
  // it on every release), so it's a reliable CN-reachable "latest version" source.
  // Caveat: jsd caches mutable refs (~12h), so detection can lag a release slightly;
  // the GitHub fallback is immediate.
  const r = await fetch(`https://cdn.jsdelivr.net/gh/${REPO}@master/package.json`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`jsd HTTP ${r.status}`);
  const d = await r.json();
  if (!d?.version) throw new Error("jsd: no version");
  return norm(d.version);
}

async function latestViaGithub(): Promise<string> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`gh HTTP ${r.status}`);
  const d = await r.json();
  if (!d?.tag_name) throw new Error("gh: no tag");
  return norm(d.tag_name);
}

/**
 * Check for a newer release. jsDelivr first, GitHub fallback. Returns null if both
 * channels are unreachable (offline / first launch). The download page is always
 * the GitHub release (that's where the APK / installers are attached); `channel`
 * records which source detected it.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const current = await getVersion().catch(() => "");
  console.info("[update] current version:", current || "(unknown)");
  if (!current) return null;
  let latest: string;
  let channel: "jsd" | "github";
  try {
    latest = await latestViaJsd();
    channel = "jsd";
    console.info("[update] jsDelivr latest =", latest);
  } catch (e) {
    console.warn("[update] jsDelivr failed, falling back to GitHub:", String(e));
    try {
      latest = await latestViaGithub();
      channel = "github";
      console.info("[update] GitHub latest =", latest);
    } catch (e2) {
      console.error("[update] both update sources failed:", String(e2));
      return null;
    }
  }
  const info: UpdateInfo = {
    current,
    latest,
    hasUpdate: cmp(latest, current) > 0,
    channel,
    url: `${GITHUB_URL}/releases/latest`,
  };
  console.info("[update] result:", JSON.stringify(info));
  return info;
}
