import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { openExternal } from "../lib/external";
import { GITHUB_URL, PRTS_URL } from "../lib/version";

const DISCLAIMER = `方舟剧场（Arkstage）是一个非官方的《明日方舟》同人 / 学习性质的剧情离线回放器。

剧情文本、立绘、音频、背景等素材均来自 PRTS Wiki，最终版权归《明日方舟》/ 上海鹰角网络（Hypergryph）所有。本应用本身不存储或分发上述素材，仅在运行时从 PRTS 获取并缓存到本地，供个人离线查阅。

请合理使用，避免对 PRTS 源站造成压力，切勿用于任何商业用途。本项目与鹰角网络、PRTS Wiki 均无隶属或合作关系，亦不对其内容的准确性负责。`;

const MIT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN
AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

const LICENSE = `方舟剧场（Arkstage）的源代码在 GitHub 公开：
${GITHUB_URL}

应用打包并使用了以下开源组件，其许可证（全文如下）一并附带：

— jQuery、PreloadJS / CreateJS、Tauri、React、React Router 等均采用 MIT 许可证：

${MIT}

— Noto Sans CJK 字体采用 SIL Open Font License 1.1（OFL-1.1）。
  全文见：https://scripts.sil.org/OFL`;

const UPSTREAM = `本应用还原游戏内演出离不开以下上游软件 / 资源，特此声明致谢：

· ScenarioSimulator 演出引擎 —— 来自 PRTS Wiki，应用在隔离 iframe 中直接运行它来重演剧情。
· jQuery —— 引擎运行依赖（MIT）。
· PreloadJS / CreateJS —— 引擎资源加载（MIT）。
· Tauri 2 —— 跨平台应用框架（MIT / Apache-2.0）。
· React 19、React Router —— 前端框架（MIT）。
· Noto Sans CJK —— 演出字体（SIL OFL 1.1）。
· 《明日方舟》全部剧情与美术素材 © 上海鹰角网络（Hypergryph）。`;

const SECTIONS: Record<string, { title: string; body: string }> = {
  disclaimer: { title: "免责声明", body: DISCLAIMER },
  license: { title: "开源许可", body: LICENSE },
  upstream: { title: "上游软件声明", body: UPSTREAM },
};

export default function AboutPage() {
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const section = sp.get("s");
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  // Second-level text view.
  if (section && SECTIONS[section]) {
    const s = SECTIONS[section];
    return (
      <div className="about-page">
        <div className="about-head">
          <button className="back-icon" onClick={() => navigate(-1)} aria-label="返回">◀</button>
          <h1>{s.title}</h1>
        </div>
        <pre className="about-text">{s.body}</pre>
      </div>
    );
  }

  return (
    <div className="about-page">
      <div className="about-head">
        <button className="back-icon" onClick={() => navigate(-1)} aria-label="返回">◀</button>
        <h1>关于</h1>
      </div>

      <div className="about-body">
        <img className="about-logo" src="/logo.png" alt="" />
        <div className="about-name">方舟剧场 Arkstage</div>
        <div className="about-ver">v{version || "…"}</div>

        <div className="about-links">
          <button className="about-link" onClick={() => openExternal(GITHUB_URL)}>项目主页（GitHub）</button>
          <button className="about-link" onClick={() => openExternal(PRTS_URL)}>PRTS Wiki</button>
        </div>

        <div className="about-rows">
          <button className="about-row" onClick={() => setSp({ s: "disclaimer" })}>
            免责声明<span className="about-arrow">›</span>
          </button>
          <button className="about-row" onClick={() => setSp({ s: "license" })}>
            开源许可<span className="about-arrow">›</span>
          </button>
          <button className="about-row" onClick={() => setSp({ s: "upstream" })}>
            上游软件声明<span className="about-arrow">›</span>
          </button>
        </div>
      </div>
    </div>
  );
}
