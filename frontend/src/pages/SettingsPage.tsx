import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isDebugConsoleEnabled, setDebugPref, debugBuildDefault } from "../lib/debugSettings";
import { isHidePlayerBack, setHidePlayerBack } from "../lib/uiSettings";
import { isAndroid } from "../lib/platform";
import { getDownloadSettings, setDownloadSettings } from "../lib/predownload";
import { useDownload } from "../lib/DownloadContext";
import { useCompression } from "../lib/CompressionContext";
import type { Tier, CompressEstimate } from "../lib/CompressionContext";
import type { StoryIndex } from "../hooks/useStoryIndex";
import { collectEnvInfo, copyText } from "../lib/diagnostics";

interface CacheStatus {
  story_index_cached: boolean;
  asset_db_cached: boolean;
  cached_stories: string[];
  total_size_bytes: number;
}

interface ResourceDirInfo {
  current: string;
  is_custom: boolean;
  default_dir: string;
  fallback_dir: string;
  default_writable: boolean;
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const hideResourceDir = isAndroid();
  const { start: startPredownload, busy: downloadBusy } = useDownload();
  const compression = useCompression();
  const [showCompress, setShowCompress] = useState(false);
  const [compressEst, setCompressEst] = useState<CompressEstimate | null>(null);
  const [selectedTier, setSelectedTier] = useState<Tier | null>(null);
  const [nickname, setNickname] = useState("博士");
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [resDir, setResDir] = useState<ResourceDirInfo | null>(null);
  const [debugConsole, setDebugConsole] = useState(isDebugConsoleEnabled());
  const [hidePlayerBack, setHidePlayerBackState] = useState(isHidePlayerBack());
  // Download tuning: concurrency + bandwidth limit (shown in KB/s; 0 = unlimited).
  const [concurrency, setConcurrency] = useState(4);
  const [rateLimitKbps, setRateLimitKbps] = useState(0);
  const [envInfo, setEnvInfo] = useState("");

  useEffect(() => {
    const saved = localStorage.getItem("prts-nickname");
    if (saved) setNickname(saved);
    refreshCacheStatus();
    invoke<ResourceDirInfo>("get_resource_dir").then(setResDir).catch(() => {});
    getDownloadSettings()
      .then((s) => {
        setConcurrency(s.concurrency);
        setRateLimitKbps(Math.round(s.rateLimitBps / 1024));
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveDownloadSettings = async (nextConcurrency: number, nextKbps: number) => {
    const c = Math.max(1, Math.min(32, Math.round(nextConcurrency) || 1));
    const kbps = Math.max(0, Math.round(nextKbps) || 0);
    setConcurrency(c);
    setRateLimitKbps(kbps);
    try {
      await setDownloadSettings({ concurrency: c, rateLimitBps: kbps * 1024 });
      showMsg(kbps === 0 ? `已保存：并发 ${c}，不限速` : `已保存：并发 ${c}，限速 ${kbps} KB/s`);
    } catch (e) {
      showMsg(`保存失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };


  const chooseResourceDir = async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: "选择资源目录" });
      if (typeof picked !== "string") return; // cancelled
      const info = await invoke<ResourceDirInfo>("set_resource_dir", { path: picked });
      setResDir(info);
      showMsg("资源目录已更改。已下载的旧资源不会自动迁移，建议重启应用。", 6000);
      refreshCacheStatus();
    } catch (e) {
      showMsg(`更改失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const resetResourceDir = async () => {
    try {
      const info = await invoke<ResourceDirInfo>("reset_resource_dir");
      setResDir(info);
      showMsg("已恢复默认资源目录，建议重启应用。", 5000);
      refreshCacheStatus();
    } catch (e) {
      showMsg(`恢复失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const togglePlayerBack = () => {
    const next = !hidePlayerBack;
    setHidePlayerBack(next);
    setHidePlayerBackState(next);
    showMsg(next ? "已隐藏播放器内的返回按钮（用系统返回手势）" : "已显示播放器内的返回按钮");
  };

  const toggleDebugConsole = () => {
    const next = !debugConsole;
    setDebugPref(next ? "on" : "off");
    setDebugConsole(next);
    showMsg(next ? "已开启调试控制台（左下角「调试日志」）" : "已关闭调试控制台");
  };

  const refreshCacheStatus = useCallback(async () => {
    try {
      const status = await invoke<CacheStatus>("get_cache_status");
      setCacheStatus(status);
    } catch {
      // Ignore
    }
  }, []);

  const copyEnvInfo = async () => {
    try {
      const info = await collectEnvInfo();
      setEnvInfo(info);
      await copyText(info);
      showMsg("环境信息已复制到剪贴板");
    } catch (e) {
      showMsg(`获取失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const showMsg = (msg: string, duration = 3000) => {
    setMessage(msg);
    if (duration > 0) setTimeout(() => setMessage(""), duration);
  };

  const saveNickname = () => {
    localStorage.setItem("prts-nickname", nickname);
    showMsg("昵称已保存");
  };

  // Cache the assets of EVERY story in the index (one big background download).
  const cacheAllStories = async () => {
    if (!confirm("将缓存全部剧情的资源，可能占用大量存储与流量，确定开始？")) return;
    setBusy(true);
    showMsg("正在获取剧情目录...", 0);
    try {
      const idx = await invoke<StoryIndex>("fetch_story_index");
      const titles = idx.categories.flatMap((c) =>
        c.chapters.flatMap((ch) => ch.stories.map((s) => s.page_title))
      );
      startPredownload(titles);
      showMsg(`已开始缓存全部 ${titles.length} 个剧情（进度见顶部下载条）`);
    } catch (e) {
      showMsg(`错误: ${e instanceof Error ? e.message : String(e)}`, 5000);
    } finally {
      setBusy(false);
    }
  };

  const clearAllCache = async () => {
    if (!confirm("确认清除所有缓存数据？（引擎已内置于软件包，不会被清除）")) return;
    try {
      await invoke("clear_cache");
      showMsg("缓存已清除");
      refreshCacheStatus();
    } catch (e) {
      showMsg(`错误: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  // Open the compression tier dialog (fetch the size estimate first).
  const openCompress = async () => {
    if (downloadBusy) {
      showMsg("请先完成当前下载，再进行资源压缩。", 4000);
      return;
    }
    setSelectedTier(null);
    setShowCompress(true);
    try {
      setCompressEst(await compression.estimate());
    } catch (e) {
      showMsg(`估算失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const confirmCompress = async () => {
    if (!selectedTier) return;
    setShowCompress(false);
    try {
      await compression.start(selectedTier);
      showMsg("已开始记忆重组（资源压缩），进度见底部进度条。");
    } catch (e) {
      showMsg(`压缩失败: ${e instanceof Error ? e.message : String(e)}`, 5000);
    }
  };

  const TIER_LABELS: Record<Tier, string> = {
    off: "关闭",
    lossless: "无损",
    q90: "高质量",
    q70: "极致",
  };

  return (
    <div className="settings-page">
      <div className="settings-content">
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
        <button className="back-icon" onClick={() => navigate(-1)} aria-label="返回">◀</button>
        <h1 style={{ margin: 0 }}>设置</h1>
      </div>

      {/* Nickname */}
      <div className="setting-group">
        <label>博士昵称（替换剧情中的 &#123;@nickname&#125;）</label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="博士"
          />
          <button className="btn-primary" onClick={saveNickname}>保存</button>
        </div>
      </div>

      {/* Download tuning */}
      <div className="setting-group">
        <label>下载设置（预下载的并发与限速）</label>
        <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "13px" }}>并发数</span>
            <input
              type="number"
              min={1}
              max={32}
              value={concurrency}
              style={{ width: "72px" }}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              onBlur={() => saveDownloadSettings(concurrency, rateLimitKbps)}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span style={{ fontSize: "13px" }}>限速 (KB/s)</span>
            <input
              type="number"
              min={0}
              step={64}
              value={rateLimitKbps}
              style={{ width: "96px" }}
              onChange={(e) => setRateLimitKbps(Number(e.target.value))}
              onBlur={() => saveDownloadSettings(concurrency, rateLimitKbps)}
            />
            <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>0 = 不限速</span>
          </div>
        </div>
      </div>

      {/* Hide the reader's on-screen back button */}
      <div className="setting-group">
        <label>播放器返回按钮</label>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button className="nav-btn" onClick={togglePlayerBack}>
            {hidePlayerBack ? "隐藏播放器返回按钮：开" : "隐藏播放器返回按钮：关"}
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            {hidePlayerBack ? "阅读时不显示返回按钮，请用系统返回手势" : "阅读时在左上角显示返回按钮"}
          </span>
        </div>
      </div>

      {/* Debug console */}
      <div className="setting-group">
        <label>调试控制台</label>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button className="nav-btn" onClick={toggleDebugConsole}>
            {debugConsole ? "调试日志：开" : "调试日志：关"}
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            {debugConsole
              ? "左下角显示「调试日志」按钮，可查看引擎错误日志"
              : "隐藏左下角的「调试日志」按钮"}
            （构建默认：{debugBuildDefault() ? "开" : "关"}）
          </span>
        </div>
      </div>

      {/* Resource directory (desktop only — Android storage is fixed) */}
      {!hideResourceDir && (
        <div className="setting-group">
        <label>资源目录（剧情图片/音频、引擎文件、缓存的存放位置）</label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "8px" }}>
          <button className="btn-primary" onClick={chooseResourceDir}>更改目录…</button>
          {resDir?.is_custom && (
            <button className="nav-btn" onClick={resetResourceDir}>恢复默认</button>
          )}
        </div>
        <div className="cache-info">
          {resDir ? (
            <>
              <div style={{ wordBreak: "break-all" }}>
                当前位置：{resDir.current}
                {resDir.is_custom ? "（自定义）" : "（默认）"}
              </div>
              <div style={{ wordBreak: "break-all", color: "var(--text-secondary)" }}>
                默认位置（exe 所在文件夹）：{resDir.default_dir}
                {resDir.default_writable ? "" : " — 不可写，已回退"}
              </div>
              <div style={{ color: "var(--text-secondary)", marginTop: "4px" }}>
                提示：更改目录不会自动迁移已下载的资源；切换后建议重启应用。
                若安装在 Program Files 等无写入权限的位置，会自动回退到系统数据目录。
              </div>
            </>
          ) : (
            <div>正在读取资源目录...</div>
          )}
        </div>
        </div>
      )}

      {/* Cache Management */}
      <div className="setting-group">
        <label>缓存管理</label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            className="btn-primary"
            onClick={cacheAllStories}
            disabled={busy || compression.busy}
          >
            缓存全部剧情
          </button>
          <button
            className="btn-primary"
            onClick={openCompress}
            disabled={busy || compression.busy || downloadBusy}
          >
            压缩资源
          </button>
          <button className="btn-danger" onClick={clearAllCache} disabled={busy || compression.busy}>
            清除所有缓存
          </button>
        </div>
        <div className="cache-info" style={{ marginTop: "12px" }}>
          {cacheStatus ? (
            <>
              <div>已缓存剧情: {cacheStatus.cached_stories.length} 个</div>
              <div>缓存总大小: {formatBytes(cacheStatus.total_size_bytes)}</div>
            </>
          ) : (
            <div>正在读取缓存状态...</div>
          )}
          {compression.tier !== "off" && (
            <div style={{ marginTop: "6px", display: "flex", alignItems: "center", gap: "10px" }}>
              <span>
                实时压缩: 已开启（{TIER_LABELS[compression.tier as Tier] ?? compression.tier}），新下载的图片会自动压缩
              </span>
              {!compression.busy && (
                <button
                  className="nav-btn"
                  style={{ fontSize: "12px" }}
                  onClick={() => compression.disableRealtime()}
                >
                  关闭实时压缩
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Compression tier dialog */}
      {showCompress && (
        <div className="dl-result-overlay" onClick={() => setShowCompress(false)}>
          <div className="dl-result" onClick={(e) => e.stopPropagation()}>
            <div className="dl-result-msg">压缩缓存图片（记忆重组）</div>
            <div className="dl-result-sub" style={{ marginBottom: "10px" }}>
              图片转 WebP 可大幅减小占用。选择一个档位后开始；压缩会替换原图，期间无法下载新资源。
              {compression.tier !== "off" && "（已是更高档位的文件不会重复压缩；切到更激进档位会二次重压。）"}
            </div>
            <div className="cache-info" style={{ marginBottom: "10px" }}>
              当前缓存: {compressEst ? formatBytes(compressEst.totalBytes) : "估算中…"}
              {compressEst && `（其中图片 ${formatBytes(compressEst.imageBytes)}）`}
            </div>
            {(["lossless", "q90", "q70"] as Tier[]).map((t) => {
              const est = compressEst
                ? t === "lossless"
                  ? compressEst.losslessBytes
                  : t === "q90"
                    ? compressEst.q90Bytes
                    : compressEst.q70Bytes
                : 0;
              const desc =
                t === "lossless"
                  ? "无损 · 画质完全不变 · 约省 50%"
                  : t === "q90"
                    ? "高质量 · 肉眼无损(SSIM≥0.99) · 约省 79%"
                    : "极致 · 体积最小 · 约省 89%";
              return (
                <label
                  key={t}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "10px",
                    padding: "8px",
                    borderRadius: "6px",
                    cursor: "pointer",
                    background: selectedTier === t ? "rgba(244,196,48,0.15)" : "transparent",
                  }}
                >
                  <input
                    type="radio"
                    name="compress-tier"
                    checked={selectedTier === t}
                    onChange={() => setSelectedTier(t)}
                  />
                  <span style={{ flex: "1 1 auto" }}>
                    <div style={{ fontWeight: 600 }}>{TIER_LABELS[t]}</div>
                    <div style={{ fontSize: "12px", opacity: 0.8 }}>{desc}</div>
                  </span>
                  <span style={{ flex: "0 0 auto", textAlign: "right" }}>
                    {compressEst ? `≈ ${formatBytes(est)}` : "—"}
                  </span>
                </label>
              );
            })}
            <div className="dl-result-actions" style={{ marginTop: "10px" }}>
              <button className="btn-primary" onClick={confirmCompress} disabled={!selectedTier}>
                开始压缩
              </button>
              <button className="nav-btn" onClick={() => setShowCompress(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* About */}
      <div className="setting-group">
        <label>关于</label>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={() => navigate("/about")}>
            关于方舟剧场
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            版本信息、免责声明、开源许可、项目与 PRTS 链接
          </span>
        </div>
      </div>

      {/* Environment / diagnostics */}
      <div className="setting-group">
        <label>环境信息（反馈问题用）</label>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={copyEnvInfo}>
            复制环境信息
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            含应用/系统/WebView 内核版本，反馈问题时一并提供
          </span>
        </div>
        {envInfo && (
          <pre
            style={{
              marginTop: "10px",
              padding: "10px",
              background: "var(--bg-tertiary)",
              borderRadius: "6px",
              fontSize: "12px",
              lineHeight: "1.5",
              color: "var(--text-secondary)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {envInfo}
          </pre>
        )}
      </div>

      {message && (
        <div
          style={{
            padding: "12px",
            background: "var(--bg-tertiary)",
            borderRadius: "4px",
            marginTop: "16px",
            color: message.startsWith("错误") ? "var(--error)" : "var(--success)",
          }}
        >
          {message}
        </div>
      )}
      </div>
    </div>
  );
}
