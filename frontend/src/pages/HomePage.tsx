import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdate, type UpdateInfo } from "../lib/version";
import { openExternal } from "../lib/external";

export default function HomePage() {
  const navigate = useNavigate();
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
    checkForUpdate()
      .then((u) => {
        if (u?.hasUpdate) setUpdate(u);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="home-page">
      <img className="home-logo" src="/logo.png" alt="方舟剧场" />
      <h1 className="home-title">方舟剧场</h1>
      <p className="home-tagline">明日方舟剧情 · 离线演出回放</p>

      <ul className="home-features">
        <li>在 PRTS 原版引擎中重演剧情——立绘、背景、配音与对话动画一致</li>
        <li>不限量网络下按章节 / 分类预下载；资源内容寻址去重，跨章节只存一份</li>
        <li>下载后完全离线播放，播放引擎与字体已内置于软件包</li>
      </ul>

      <div className="home-actions">
        <button className="btn-primary" onClick={() => navigate("/browse")}>
          浏览剧情
        </button>
        <button className="nav-btn" onClick={() => navigate("/settings")}>
          设置
        </button>
      </div>

      {update ? (
        <button
          className="home-version has-update"
          onClick={() => openExternal(update.url)}
          title={`点击前往 ${update.channel === "jsd" ? "jsDelivr 检测到的" : "GitHub"} 发布页下载 v${update.latest}`}
        >
          v{version} · <span className="blink">检测到更新 v{update.latest} ›</span>
        </button>
      ) : (
        <span className="home-version">v{version || "…"}</span>
      )}
    </div>
  );
}
