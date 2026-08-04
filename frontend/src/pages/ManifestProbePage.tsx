import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runPredownload, type PredownloadStatus } from "../lib/predownload";
import { getEntries } from "../lib/debugLog";

/**
 * Deterministic development-only probe for the real manifest + Rust download
 * pipeline.  App.tsx only mounts this page in Vite development builds when the
 * URL contains one or more `manifestProbe` query parameters.  The terminal test
 * can therefore assert cache/download side effects without fragile pixel clicks.
 */
export default function ManifestProbePage({ titles }: { titles: string[] }) {
  const started = useRef(false);
  const [message, setMessage] = useState(`starting ${titles.length} stories`);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let latest: PredownloadStatus | null = null;
    void runPredownload(
      titles,
      (status) => {
        latest = status;
        setMessage(JSON.stringify(status));
      },
      () => {}
    ).then(async (result) => {
      const report = { ok: true, titles, status: latest, logs: getEntries(), ...result };
      setMessage(JSON.stringify(report));
      await invoke("save_to_cache", {
        key: "e2e-manifest-probe",
        data: JSON.stringify(report),
      });
    }).catch(async (error) => {
      const report = { ok: false, titles, status: latest, logs: getEntries(), error: String(error) };
      setMessage(JSON.stringify(report));
      await invoke("save_to_cache", {
        key: "e2e-manifest-probe",
        data: JSON.stringify(report),
      }).catch(() => {});
    });
  }, [titles]);

  return <pre id="manifest-probe-result">{message}</pre>;
}
