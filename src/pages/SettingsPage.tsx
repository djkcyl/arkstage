import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { isDebugConsoleEnabled, setDebugPref, debugBuildDefault } from "../lib/debugSettings";

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
  const [nickname, setNickname] = useState("博士");
  const [cacheStatus, setCacheStatus] = useState<CacheStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [allowOnline, setAllowOnline] = useState(true);
  const [resDir, setResDir] = useState<ResourceDirInfo | null>(null);
  const [debugConsole, setDebugConsole] = useState(isDebugConsoleEnabled());

  useEffect(() => {
    const saved = localStorage.getItem("prts-nickname");
    if (saved) setNickname(saved);
    refreshCacheStatus();
    invoke<boolean>("get_allow_online").then(setAllowOnline).catch(() => {});
    invoke<ResourceDirInfo>("get_resource_dir").then(setResDir).catch(() => {});
  }, []);

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

  const toggleDebugConsole = () => {
    const next = !debugConsole;
    setDebugPref(next ? "on" : "off");
    setDebugConsole(next);
    showMsg(next ? "已开启调试控制台（左下角「调试日志」）" : "已关闭调试控制台");
  };

  const toggleAllowOnline = async () => {
    const next = !allowOnline;
    await invoke("set_allow_online", { value: next });
    setAllowOnline(next);
    showMsg(next ? "已允许联网（缺失资源将自动拉取并缓存）" : "已禁止联网（缺失资源将提示获取）");
  };

  const updateGlobalData = async () => {
    setBusy(true);
    showMsg("正在更新全局数据...", 0);
    try {
      const bundle = await invoke("fetch_widget_bundle", { pageTitle: "W2G/BEG" });
      await invoke("save_to_cache", { key: "widget-bundle-v2", data: JSON.stringify(bundle) });
      showMsg("全局数据已更新");
      refreshCacheStatus();
    } catch (e) {
      showMsg(`错误: ${e}`, 5000);
    } finally {
      setBusy(false);
    }
  };

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
      <div className="settings-content">
      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "24px" }}>
        <button className="nav-btn" onClick={() => navigate("/")}>◀</button>
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

      {/* Network policy */}
      <div className="setting-group">
        <label>联网策略</label>
        <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
          <button className="nav-btn" onClick={toggleAllowOnline}>
            {allowOnline ? "联网：开" : "联网：关"}
          </button>
          <span style={{ fontSize: "13px", color: "var(--text-secondary)" }}>
            {allowOnline ? "缺失资源将自动从 PRTS 拉取并缓存" : "仅播放已缓存资源，缺失时提示获取"}
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

      {/* Resource directory */}
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

      {/* Cache Management */}
      <div className="setting-group">
        <label>缓存管理</label>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button className="btn-primary" onClick={precacheEngine} disabled={busy}>
            预缓存引擎
          </button>
          <button className="btn-primary" onClick={updateGlobalData} disabled={busy}>
            更新全局数据
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
    </div>
  );
}
