import { getVersion } from "@tauri-apps/api/app";

// App version + update check. The current version comes from the Tauri app
// metadata (tauri.conf.json). The latest is checked jsDelivr-first (fast/reachable
// in CN), GitHub API as fallback; both read the repo's newest release tag.

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
  const r = await fetch(`https://data.jsdelivr.com/v1/packages/gh/${REPO}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`jsd HTTP ${r.status}`);
  const d = await r.json();
  const v = d?.tags?.latest || d?.versions?.[0]?.version;
  if (!v) throw new Error("jsd: no version");
  return norm(v);
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
  if (!current) return null;
  let latest: string;
  let channel: "jsd" | "github";
  try {
    latest = await latestViaJsd();
    channel = "jsd";
  } catch {
    try {
      latest = await latestViaGithub();
      channel = "github";
    } catch {
      return null;
    }
  }
  return {
    current,
    latest,
    hasUpdate: cmp(latest, current) > 0,
    channel,
    url: `${GITHUB_URL}/releases/latest`,
  };
}
