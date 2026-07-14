// StoryLine (主题曲/回想 篇章) icons, sourced from prts.wiki (媒体: 图标 曲谱 *).
// Small (108×108) PNGs bundled with the app; keyed by the StoryLine display name
// used as a category name in the bundled story index.
import rl from "./rl.png";
import ur from "./ur.png";
import la from "./la.png";
import kj from "./kj.png";
import si from "./si.png";
import ka from "./ka.png";
import su from "./su.png";
import rh from "./rh.png";
import ae from "./ae.png";
import le from "./le.png";
import ta from "./ta.png";
import st from "./st.png";
import ts from "./ts.png";

const STORYLINE_ICONS: Record<string, string> = {
  方舟: rl,
  燎原: ur,
  那被祝福的: la,
  山雪与银铁: kj,
  七丘的新芽: si,
  霓虹之下: ka,
  岁岁今朝: su,
  摘取未来之人: rh,
  自海渊的一瞥: ae,
  高塔迷影: le,
  薪火重燃: ta,
  夏日律动: st,
  泰拉奇谈: ts,
};

/** Icon URL for a StoryLine category name, or undefined (主线/未分类 have no icon). */
export function storylineIcon(name: string): string | undefined {
  return STORYLINE_ICONS[name];
}
