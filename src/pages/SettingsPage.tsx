import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";

interface CacheStatus {
  story_index_cached: boolean;
  asset_db_cached: boolean;
  cached_stories: string[];
  total_size_bytes: number;
}

export default function SettingsPage() {
  const navigate = useNavigate();
  const [nickname, setNickname] = useState("博士");
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("prts-nickname");
    if (saved) setNickname(saved);
    refreshCacheStatus();
  }, []);

  const refreshCacheStatus = useCallback(async () => {
    try {
      const status = await invoke<CacheStatus>("get_cache_status");
      setCacheStatus(status);
    } catch {
      // Ignore
    }
  }, []);

  const showMsg = (msg: string, duration = 3000) => {
    setMessage(msg);
    if (duration > 0) setTimeout(() => setMessage(""), duration);
  };

  const saveNickname = () => {
    localStorage.setItem("prts-nickname", nickname);
    showMsg("昵称已保存");
  };

  const precacheEngine = async () => {
    setBusy(true);
    showMsg("正在缓存引擎代码...", 0);
    try {
      // Cache widget bundle
      const bundle = await invoke("fetch_widget_bundle", { pageTitle: "W2G/BEG" });
      await invoke("save_to_cache", {
        key: "widget-bundle-v2",
        data: JSON.stringify(bundle),
      });

      // Cache external JS/CSS/font files via Rust
      const externals = [
        { url: "https://code.jquery.com/jquery-3.7.1.min.js", category: "engine", filename: "jquery.min.js" },
        { url: "https://static.prts.wiki/npm/PreloadJS@1.0.1/preloadjs.min.js", category: "engine", filename: "preloadjs.min.js" },
        { url: "https://static.prts.wiki/assets/scenario/krliov.toolbox.js", category: "engine", filename: "krliov.toolbox.js" },
        { url: "https://static.prts.wiki/assets/scenario/arknights-scenario.css", category: "engine", filename: "arknights-scenario.css" },
        { url: "https://static.prts.wiki/assets/scenario/fonts/NotoSans.ttf", category: "engine", filename: "NotoSans.ttf" },
      ];
      for (const ext of externals) {
        await invoke("download_asset", ext);
      }

      showMsg("引擎代码及依赖已全部缓存");
      refreshCacheStatus();
    } catch (e) {
      showMsg(`错误: ${e}`, 5000);
    } finally {
      setBusy(false);
    }
  };

  const precacheIndex = async () => {
    setBusy(true);
    showMsg("正在缓存剧情目录...", 0);
    try {
      const fresh = await invoke("fetch_story_index");
      await invoke("save_to_cache", {
        key: "story-index",
        data: JSON.stringify(fresh),
      });
      showMsg("剧情目录已缓存");
      refreshCacheStatus();
    } catch (e) {
      showMsg(`错误: ${e}`, 5000);
    } finally {
      setBusy(false);
    }
  };

  const clearAllCache = async () => {
    if (!confirm("确认清除所有缓存数据？")) return;
    try {
      await invoke("clear_cache");
      showMsg("缓存已清除");
      refreshCacheStatus();
    } catch (e) {
      showMsg(`错误: ${e}`, 5000);
    }
  };

  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  };

  const widgetCached = cacheStatus
    ? cacheStatus.cached_stories.length > 0 || cacheStatus.story_index_cached
    : false;

  return (
    <div className="settings-page">
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
        <button className="nav-btn" onClick={() => navigate("/")}>◀</button>
        <h1 style={{ margin: 0 }}>设置</h1>
      </div>

      {/* Nickname */}
      <div className="setting-group">
        <label>博士昵称（替换剧情中的 &#123;@nickname&#125;）</label>
        <div style={{ display: "flex", gap: "8px" }}>
          <input
            type="text"
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder="博士"
          />
          <button className="btn-primary" onClick={saveNickname}>保存</button>
        </div>
      </div>

      {/* Cache Management */}
      <div className="setting-group">
        <label>缓存管理</label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={precacheEngine} disabled={busy}>
            预缓存引擎
          </button>
          <button className="btn-primary" onClick={precacheIndex} disabled={busy}>
            预缓存目录
          </button>
          <button className="btn-danger" onClick={clearAllCache} disabled={busy}>
            清除所有缓存
          </button>
        </div>
        <div className="cache-info" style={{ marginTop: "12px" }}>
          {cacheStatus ? (
            <>
              <div>剧情目录: {cacheStatus.story_index_cached ? "✓ 已缓存" : "✗ 未缓存"}</div>
              <div>引擎代码: {widgetCached ? "✓ 已缓存" : "✗ 未缓存"}</div>
              <div>已缓存剧情: {cacheStatus.cached_stories.length} 个</div>
              <div>缓存总大小: {formatBytes(cacheStatus.total_size_bytes)}</div>
            </>
          ) : (
            <div>正在读取缓存状态...</div>
          )}
        </div>
      </div>

      <div className="setting-group">
        <label>使用说明</label>
        <div className="cache-info">
          <div>1. 首先点击「预缓存引擎」下载播放器所需的代码和样式</div>
          <div>2. 点击「预缓存目录」下载剧情列表</div>
          <div>3. 浏览和打开剧情时会自动缓存每个故事的脚本</div>
          <div>4. 缓存后可离线阅读已缓存的剧情</div>
        </div>
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
  );
}
