# 在线书架元数据与剧情资源容错设计

日期：2026-07-14

## 背景

章节 StoryLine 归类、书架封面和章节头图目前编译进客户端。上游新增剧情后，
`剧情一览` 会立即让客户端看到新书目，但内置 `storylines.json` 与图片仍停留在发版时，
因此新书目被归入「特殊」且没有封面。故事集「丛林症结」还暴露了 PRTS 剧情模拟器
数据表的另一种更新竞态：`datas_char` 和 `datas_back` 已包含新资源，`datas_link` 未包含
新角色组，导致脚本里的 `avg_4229_aphris_1#…` 等名称无法解析，预载阶段直接跳过立绘。

## 已核实事实

- 「丛林症结」内部活动 ID 为 `act21mini`，英文资源名为 `bolivar_diagnosed`。
- 游戏客户端 2.7.51 的更新公告明确指出「泰拉奇谈」故事关系和顺序更新；该故事集应归入
  「泰拉奇谈」，当前按最新故事顺序放在该篇章末尾。
- 封面源为 `ArknightsAssets/ArknightsAssets2@cn` 的
  `assets/dyn/arts/ui/mixstory/kvs/kv_bolivar_diagnosed.png`。
- 新背景、谬因、佩德洛与 `avg_npc_232x` 立绘均已存在于同一上游 2026-07-10 资源提交。
- PRTS 的 `datas_char`/`datas_back` 已列出这些图片 URL，缺失的是 `datas_link` 的角色组描述；
  因而修复点是补全链接表，媒体仍走现有 PRTS 直连缓存链路。

## 资源分支

同仓库新增独立 `resources` 分支，只保存运行时书架资源：

```text
metadata.json
covers/*.webp
banners/*.webp
```

客户端固定从以下 jsDelivr 路径读取：

```text
https://cdn.jsdelivr.net/gh/djkcyl/arkstage@resources/metadata.json
https://cdn.jsdelivr.net/gh/djkcyl/arkstage@resources/<metadata 中的相对路径>
```

`metadata.json` 包含 schema 版本、数据版本、StoryLine 清单，以及封面/头图的相对路径和
宽高。图片文件名带内容哈希；内容变化会产生新路径，避免 jsDelivr 与本地缓存继续命中旧图。

## 客户端启动与缓存

1. 启动时先读取 `bookshelf-metadata` 本地缓存，成功后立即用于归类与绘制。
2. 同时用 `cache: "no-store"` 拉取 jsDelivr 元数据；校验 schema、路径和尺寸后原子替换内存与缓存。
3. 首次启动如果元数据网络失败，剧情目录仍可显示，所有书目暂归「特殊」并使用 logo 占位。
4. 封面/头图按需通过 Rust 下载器写入 `assets/bookshelf/`。哈希文件名保证更新与旧缓存共存，
   新元数据会自然切换到新图；断网时已落盘图片继续可用。
5. 客户端包删除 `assets/covers`、`assets/banners`、`cover-dims.json` 与 `storylines.json`，
   避免业务资源随软件包固化。

## 剧情资源链接容错

在引擎脚本执行、`data.init()` 读取 `<pre>` 数据前修补 `datas_link`：

1. 解析 `datas_char` 的全部键，按 `base[-expression]$group` 聚合。
2. 对 `datas_link` 已存在的组保持原样。
3. 仅为缺失组生成链接描述，数组按 `$group`、表情序号排序，保证 `#N$G` 解析语义一致。
4. 使用保守的舞台默认布局；后续资源分支可通过 `scenarioLinks` 为具体组提供精确 `pos/size` 覆盖。
5. 清单捕获与实际播放共用同一修补逻辑，下载器能够看到并缓存补出的立绘 URL。

该容错适用于未来 PRTS 再次出现“图片表已更新、链接表滞后”的窗口，不需要针对角色 ID
硬编码。现有链接数据永远优先，因此不会改变旧剧情的精确构图。

## 失败边界与安全

- 远程 JSON 必须是 HTTPS/jsDelivr 同仓库路径；图片相对路径拒绝协议、`..` 与反斜杠。
- schema 不兼容、JSON 不完整或网络错误时保留上次成功缓存。
- 在线元数据只控制书架分类、图片路径与可选的角色布局数值，不能注入脚本或 HTML。
- PRTS 剧情文本和媒体来源保持不变。

## 验证

- TypeScript 单元级测试：元数据校验、无缓存回退、StoryLine 归类、远程图片路径。
- 引擎链接修补测试：覆盖 `avg_4229_aphris_1#1$2`、`avg_npc_2321_1#11$1`、
  已有链接不被覆盖、背景表不受影响。
- 静态检查、Rust 测试、前端生产构建。
- Android arm64 APK 构建，供真机复核「土壤病」开场和种植园背景。
