# PRTS 演出引擎热更新与资源一致性设计

日期：2026-07-17

## 问题归因

“丛林症结”的线上 PRTS 页面已经包含报错中的立绘、背景和 CG URL，但旧客户端存在四条可独立触发白屏/丢图的路径：

1. 剧情脚本、全局 `datas_*` 表与 manifest 分别缓存，可能来自不同 PRTS 版本；
2. 外部 ScenarioSimulator 依赖总是优先使用安装包副本，无法跟随 PRTS 更新；
3. 解析器只提取固定数据块和精确形式的脚本标签，页面结构演进时会静默漏取；
4. 200 响应中的 HTML 错误页、空文件或中断写入会永久占据图片缓存键。

## 一致性模型

- 互动播放使用“同页原子快照”：一次 PRTS 响应同时提取剧情脚本、所有 `datas_*` 数据块、DOM 和内联引擎，计算 SHA-256 后才写入 `story-runtime-v3`。
- CSS、jQuery、PreloadJS、toolbox 在每次应用启动时 fresh-first 更新；文件先验证特征标记，再以可恢复的原子替换写入。失败顺序为 last-known-good → 安装包应急副本。
- 预下载先批量查询 MediaWiki oldid。仅当页面 oldid、全局 bundle 哈希和外部引擎哈希全部匹配时，才复用 v2 manifest；其余情况重新生成。
- 启动引擎前按 PRTS preload 的键解析规则审计背景、CG 与角色引用，并继续使用通用的 `datas_char` → `datas_link` 补全。
- 图片读取和下载均校验魔数；HTML、空文件和无效图片会被删除并重新获取。所有媒体和 JSON 更新均保留可恢复备份，避免进程中断破坏最后可用版本。

## 验证闭环

- `npm run verify:prts-sync`：默认检查“丛林症结”7 篇，也接受任意页面标题参数；解析引用后对最终媒体 URL 做并发 HEAD 校验。
- `.github/workflows/verify-prts-sync.yml`：每日和手动运行上述检查。
- `PRTS_LIVE_NETWORK=1 cargo test ... live_`：使用应用自身 reqwest/rustls 路径验证同页快照与引擎文件热更新。
- 普通 CI 覆盖动态 `datas_*`、灵活脚本标签、坏图片自愈、中断恢复、版本化 manifest 和前后端构建。

2026-07-17 实测结果：7 个页面共 1517 次演出图片引用，0 个映射缺失；169 个唯一图片 URL 全部返回图片内容类型。当前 PRTS 仍有 5 个角色组需要客户端通用补全，因此不能移除 `repairScenarioLinks`。
