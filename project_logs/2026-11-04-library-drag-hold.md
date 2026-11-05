# 2026-11-04 素材库原地长按外拖反馈

用户要求：素材库按住超过阈值且偏移不超过 4px，就立即显示已有外拖视图；不能等到鼠标移出窗口才显示。本次修正手势与反馈时机，不重新设计已确认的 HUD。

## 定位与复用

1. 阅读 PROJECT、UI 规范、开发计划／复用地图及 EXTERNAL-DRAG；搜索所有 FileMediaCard 调用、现有画布长按、载荷锁及 native bridge。
2. 找到两层原因：素材库仅从 HTML dragstart 起拖，没有静止按压计时；桥接层又会在素材库同窗 dragover 时隐藏 HUD，使源位置的原生事件立即隐藏提示。
3. 复用 600ms 控制器、externalDrag 原生桥、HUD 与两帧绘制、取消 ACK、完整 Asset ID 载荷。新建 useLibraryDragHold 只负责卡片按压生命周期；不另建原件解析、拖影或模糊层。

## 实施与行为验证

1. 先添加正式卡片隔离回归，原实现在 600ms 无 dragstart 的场景没有遮罩，实际 RED。
2. FileMediaCard 通过 dragAssetIds 在交接时取得完整选择，接入 VirtualCatalog、ConnectedCollections、CanvasFrequentAssets。集合的失联与多选未读全保护保持。
3. 图片／视频／音频非播放控件区域，鼠标主键且无修饰键时允许长按。600ms、位移不超过 4px 即启动。文本目前不在 native files 允许列表中，本次不新增文本长按；音频波形与播放控件不触发外拖。
4. 画布保持既有达到 4px 就取消的规则；库内通过同一计时器的阈值谓词接受恰好 4px。按下后滚动、松手、Esc、失焦、丢失按键、隐藏／卸载取消待启动手势。
5. 实际 Chromium 鼠标验证暴露恰好 4px 就会提前发送 dragstart。库内在容差内延迟该事件；后续继续超过 4px 时直接启动原有普通拖动，避免浏览器取消 dragstart 后同次按压无法重新起拖。普通移动不会再触发本次长按。
6. 长按传 externalOnly，窗口内也持续显示 HUD，并拒绝投回 Bowerbird。普通直接拖动保留内部集合／画板落点、同窗隐藏／离窗恢复提示的行为。
7. 拦截鼠标尾随点击，下一次 pointerdown 清理旧拦截；键盘激活不被吞掉。真实首页按住时显示，松手不打开原图，下一次正常点击可打开预览。
8. 修正隔离 external-drag 夹具的定位容器，防止绝对定位的集合区域覆盖真实鼠标目标；增加视频／文本样本和卸载入口。
9. 旧画布回归仍以旧媒体弹层名称查找，更新为验证确有对话框，并独立重置鼠标／键盘恢复场景。其复用夹具返回只有 prompt、缺少 images 的假 generation_history，引起新版 CreationImagePreview 的 includes 异常；只在外拖夹具返回合法空历史，不修改产品预览逻辑，不屏蔽页面异常。
10. 最初截图在渐显起始帧，画面尚未显现；测试增加真实计算 opacity 到位后的截图。检查正式首页截图，确认源位置投影、全窗模糊与“拖到其他应用中使用”提示可见；没有修改动画或跳到终帧来规避检查。

## 最终验证

- `node scripts/library-drag-hold-ui.test.mjs`：通过。含 599／600ms、恰好 4px、超过后回位、原点 dragover、同窗拒绝、多选、取消、音视频、播放控件排除、文本排除、卸载、真实鼠标微抖后继续拖动、真实首页与尾随点击。
- `node scripts/external-drag-ui.test.mjs`：通过；既有直接外拖及内部载荷行为兼容。
- `node scripts/canvas-drag-out-ui.test.mjs`：补齐上述夹具后通过；普通移动、画布长按、多选／组／会话、内部回落、迟到取消与键鼠恢复。
- `node scripts/canvas-drag-backdrop-ui.test.mjs`：17 项通过；共用 HUD／取消／同窗直接拖动的既有契约。
- `node --experimental-strip-types --test scripts/canvas-drag-hold.test.mjs`：5 项通过。
- `pnpm exec tsc --noEmit`：通过。
- `pnpm exec vite build --outDir .tmp/library-drag-hold-build`：通过；保留现有大于 500 kB chunk 提示。
- 隔离 Chromium 使用本机 fixture、受控 IPC 和合成素材；禁止非本机网络，无真实用户文件写入或模型调用。

## ub-mode 工具与证据

- 使用现有 `.tmp/ub-tools` Python 适配器运行 crapper／dryer／mutator，无新增运行依赖。
- crapper：新控制逻辑各函数 CC 不超过 8；原有 startExternalDrag 为 30。工具没有实测覆盖率输入，CRAP 为 N/A，不能据 CC 声称 CRAP 达标；不为本次时机修正重构整个原生生命周期。
- dryer：此次检查的计时器／新 hook／原生前端桥，没有相似度 >=0.8 的候选。
- mutator：在隔离源码副本上对位移计算、严格边界和 externalOnly 交接执行 4 个定向变异，4 killed、0 survived；逐个确认失败于行为断言，不是编译／环境错误。这不是全文件变异覆盖。副本恢复后 SHA256 与正式 hook 相同。
- 工具证据：`.tmp/library-drag-hold/{crapper,dryer,mutator,mutation-run}.txt` 与 `logs/useLibraryDragHold.ts-*.log`；这些本机产物不纳入提交。
- 截图：`apps/desktop/.tmp/library-drag-hold/home-stationary-hud.png`、`stationary-hud.png`；前者为真实首页组件。构建结果为同目录 `build.txt`。运行期间端口与浏览器均由 finally 关闭。
- 最终检查 diff 与独立暂存清单；PROJECT 只暂存本次全息反馈约定补充，不夹带并行图片预览／浏览器等修改。同步更新本机复用地图 `dev-doc/reuse/DESKTOP.md` 的调用入口；该文件原本未跟踪且由 `.gitignore` 排除，不为本次修正强行纳入整份地图。本次没有建立 worktree，不清理其他任务的工作区或临时产物。

## 交付边界

只完成前端源码、文档、隔离验证和本地提交。没有重启／替换用户程序，没有打包、发布或远程推送。Windows／Mac 原生适配器、原件交付与缩略图生成均未修改；本轮原地长按触发后的真实跨应用接收和 Mac 实机仍须分别验证，浏览器控制 IPC 不代表系统验收。
