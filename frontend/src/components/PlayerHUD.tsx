import { useEffect, useRef, useState } from "react";
import type { PlayerController } from "../lib/modernEngine";
import nativeLayout from "../assets/player-ui/layout.json";
import settingsIcon from "../assets/player-ui/settings.png";
import logIcon from "../assets/player-ui/log.png";
import hideIcon from "../assets/player-ui/hide.png";
import autoIcon from "../assets/player-ui/auto.png";
import skipIcon from "../assets/player-ui/skip.png";
import speedFrame from "../assets/player-ui/speed-frame.png";
import speedOne from "../assets/player-ui/speed-1.png";
import speedTwo from "../assets/player-ui/speed-2.png";
import speedThree from "../assets/player-ui/speed-3.png";
import "../styles/player.css";

type Panel = "settings" | "log" | "skip" | null;
type Control = keyof typeof nativeLayout.layout;
function geometry(key: Control) {
  const rect = nativeLayout.layout[key];
  let x = rect.anchor[0] * nativeLayout.stage[0] + rect.position[0];
  let y = (1 - rect.anchor[1]) * nativeLayout.stage[1] - rect.position[1];
  if (key === "btn_speed") {
    const auto = geometry("btn_auto");
    x = auto.x + auto.width / 2 + rect.position[0];
    y = auto.y - auto.height / 2 - rect.position[1];
  }
  return { x, y, width: rect.size[0], height: rect.size[1] };
}
function hitbox(key: Control) {
  const box = geometry(key);
  const hotspot = nativeLayout.layout[key].children.hotspot;
  return { left: box.x + hotspot.position[0] - hotspot.size[0] / 2,
    top: box.y - hotspot.position[1] - hotspot.size[1] / 2,
    width: hotspot.size[0], height: hotspot.size[1] };
}
function graphic(key: Control, width: number, height: number, dx = 0, dy = 0) {
  const center = geometry(key), hit = hitbox(key);
  return { left: center.x - hit.left - width / 2 + dx,
    top: center.y - hit.top - height / 2 + dy, width, height };
}

function transcript(script: string, lastLine?: number | null): string {
  const lines = script.split("\n");
  const selection = lastLine === undefined ? lines : lines.slice(0, (lastLine ?? -1) + 1);
  return selection.flatMap((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("//")) return [];
    const dialogue = line.match(/^\[name\s*=\s*["']([^"']*)["']\]\s*(.*)$/i);
    if (dialogue) return [`${dialogue[1] ? `${dialogue[1]}\u3000` : ""}${dialogue[2]}`];
    if (line.startsWith("[")) return [];
    return [line];
  }).join("\n\n") || "剧情尚未开始";
}

export default function PlayerHUD({ controller, script, onExit, onError }: {
  controller: PlayerController; script: string; onExit: () => void; onError: (error: string) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [state, setState] = useState(() => controller.state());
  const [panel, setPanel] = useState<Panel>(null);
  const [hidden, setHidden] = useState(false);
  const [allText, setAllText] = useState(false);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem("prts-player-volume") ?? 1));

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setScale(Math.min(entry.contentRect.width / nativeLayout.stage[0], entry.contentRect.height / nativeLayout.stage[1]));
    });
    if (surface.current) observer.observe(surface.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    controller.setVolume(Number.isFinite(volume) ? volume : 1);
    localStorage.setItem("prts-player-volume", String(volume));
  }, [controller, volume]);
  useEffect(() => {
    const timer = setInterval(() => setState(controller.state()), 120);
    return () => clearInterval(timer);
  }, [controller]);

  const run = (action: () => Promise<void>) => { void action().catch((error) => onError(String(error))); };
  const open = (value: Panel) => { controller.setAuto(false); setPanel(value); };
  const reveal = () => { controller.setUIVisible(true); setHidden(false); };

  return <div className="reader-hud-surface" ref={surface}>
    {hidden ? <button className="reader-reveal" aria-label="恢复剧情界面" onClick={reveal} /> : <>
      <nav className="reader-hud" aria-label="剧情播放控制" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        <button className="reader-icon reader-settings" style={hitbox("btn_setting")} aria-label="剧情设置" title="设置" onClick={() => open("settings")}><img src={settingsIcon} style={graphic("btn_setting", 40, 40, 0, 3)} alt="" /></button>
        <button className="reader-icon reader-log" style={hitbox("btn_log")} aria-label="剧情日志" title="LOG" onClick={() => { setAllText(false); open("log"); }}><img src={logIcon} style={graphic("btn_log", 44, 44)} alt="" /></button>
        <button className="reader-icon reader-hide" style={hitbox("btn_hide")} aria-label="隐藏剧情界面" title="隐藏界面" onClick={() => { controller.setUIVisible(false); setHidden(true); }}><img src={hideIcon} style={graphic("btn_hide", 44, 44)} alt="" /></button>
        <button className="reader-speed" style={hitbox("btn_speed")} aria-label="切换播放速度" title={`自动播放速度 ${state.speed} 倍`} onClick={() => controller.setSpeed(controller.state().speed % 3)}>
          <img src={speedFrame} style={graphic("btn_speed", 84, 28, 1, 0)} alt="" />
          <img src={[speedOne, speedTwo, speedThree][state.speed - 1] ?? speedOne} style={graphic("btn_speed", 30, 20, 1, 0)} alt="" />
        </button>
        <button className="reader-auto" style={hitbox("btn_auto")} aria-label="自动播放" aria-pressed={state.auto} onClick={() => {
          controller.setAuto(!controller.state().auto);
          if (controller.state().state === "idle") run(() => controller.advance());
        }}><img src={autoIcon} style={graphic("btn_auto", 75, 31)} alt="" /></button>
        <button className="reader-skip" style={hitbox("btn_skip")} aria-label="跳过剧情" disabled={!state.canSkip} onClick={() => open("skip")}><img src={skipIcon} style={graphic("btn_skip", 77, 29)} alt="" /></button>
      </nav>
      {state.state === "finished" && <button className="reader-finished" onClick={onExit}>剧情结束 · 返回书架</button>}
    </>}

    {panel && <div className="reader-dialog-backdrop" onClick={() => setPanel(null)}>
      <section className={`reader-dialog${panel === "log" ? " reader-transcript" : ""}`} role="dialog" aria-modal="true" aria-label={panel === "settings" ? "剧情设置" : panel === "log" ? "剧情日志" : "确认跳过剧情"} onClick={(event) => event.stopPropagation()}>
        <header><span>{panel === "settings" ? "设置" : panel === "log" ? "LOG" : "跳过剧情"}</span><button aria-label="关闭面板" onClick={() => setPanel(null)}>×</button></header>
        {panel === "settings" && <>
          <label className="reader-volume">音量 <input aria-label="音量" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label>
          <div className="reader-menu-actions">
            <button onClick={() => { setPanel(null); run(() => controller.reset()); }}>重新播放</button>
            <button onClick={onExit}>退出阅读</button>
          </div>
        </>}
        {panel === "log" && <>
          <button className="reader-text-toggle" aria-pressed={allText} onClick={() => setAllText(!allText)}>{allText ? "查看已读记录" : "查看全部文本"}</button>
          <pre>{transcript(script, allText ? undefined : state.line)}</pre>
        </>}
        {panel === "skip" && <>
          <p>是否跳过当前剧情段落？</p>
          <div className="reader-menu-actions"><button onClick={() => setPanel(null)}>取消</button><button onClick={() => {
            setPanel(null);
            run(async () => { await controller.skip(); if (controller.state().state === "finished") onExit(); });
          }}>跳过</button></div>
        </>}
      </section>
    </div>}
  </div>;
}
