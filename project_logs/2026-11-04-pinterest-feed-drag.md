# Pinterest 瀑布流直接采集修复

## 需求与行动

- 用户报告 Pinterest 瀑布流不能直接拖图采集，需进入详情。沿用 ub-mode，先复现再修复；核对当前 PROJECT、探索协议、开发计划与复用地图，保留其他任务的修改。
- 记忆索引无相关命中。并行核对站点卡片结构、真实浏览器起拖及原生初始化；不访问用户库或账号。
- 复用 `source_browser_drag.js` 的指针命中／手势冻结、既有候选图片清晰度选择、标准拖放载荷与原生采集链路。重点检查卡片覆盖层与此前小红书正文防穿透规则的冲突，不新增采集入口或独立入库流程。
- 核对当天公开 Pinterest build 仍为 ebbff58。[官方 PinRep bundle](https://s.pinimg.com/webapp/85140-3ec862a5960f5ddf.mjs) 显示：`pin-card-hover-overlay-top-wash` 为 48px 高、40% 黑色，`pin-card-hover-overlay-gradient-full` 为该颜色至透明的渐变；原 `passThrough` 只允许完全透明背景，因此这两层必然拦住图片。完整结构与资源冻结在 `.tmp/pinterest-feed-drag/research.md`。
- 真实结构为 Pin → pinWrapper → 主链接 → 图像 wrapper → pincard Box，图片分支与 hover 分支位于同一 Box。首次“深层共同祖先”猜测没有官网证据，删除该方向的试改与正向测试要求，保留原四层祖先边界；不为简化夹具修改产品。
- 只添加受限 Pinterest hover 识别：精确 HTTPS 域名、官方覆盖层、同一最近 pinWrapper，两种装饰层才可放行；仍验证完整绘制顺序及实际指针命中。普通面板／文字／按钮等维持原规则。质量检查后按职责提取原透明色判断与绘制栈检查，逻辑不变。
- Chromium 冻结旧脚本红测中，官方顶部 wash、渐变和 Lens 结果三项失败，其余对照通过。旧原生 EXE 同样复现：详情／透明层可采，两种官方 hover 只有 Pin 链接而无图片载荷。旧原生证据 `apps/desktop/.tmp/pinterest-feed-native-1793724657313/result.json`。

## 验证与边界

- 正式 `scripts/pinterest-feed-drag.test.mjs` 当前 15/15 通过：官方两种覆盖层、透明对照、裸图详情、Lens 瀑布流及按钮／文字／弹窗／普通遮罩／异站／不同最近 Pin wrapper 拒绝。真实 Chromium 鼠标起拖验证最高 srcset 图片地址、原 Pin 来源与一次通知。共享夹具与来源说明位于 `scripts/fixtures/pinterest-feed-drag/`。
- 原有 `scripts/explorer-selection-drag.test.mjs` 首轮和职责提取后的最终复跑均 15/15，`scripts/pinterest-layout.test.mjs` 10/10 通过。文字负例在读坐标前先真实悬停并等待可见、拒绝零尺寸；修正后最终专项 15/15 再绿，避免未命中文字的假通过。
- ub-mode 工具实跑：匿名 IIFE 工具不直接归属函数，沿用具名函数原字节／原行号投影，完整产品脚本实际运行取 V8 覆盖并转 LCOV，不把空报告算通过。转换先匹配实际 bridge 占位替换后的执行文本，再校正 addInitScript 包装偏移；不把两份脚本假定为字节完全相同。本次六个 helper 实测 CRAP 最高 9（其余 7／5／5／4／3）、指标覆盖 100%，dryer 0.8 阈值无重复。完整脚本 V8 行覆盖 88.44%、分支 92.41%；旧 `mediaAtPointer` 与匿名事件处理器不纳入本次 CRAP 门槛，不声称整个脚本达到门槛或全覆盖。定向变异与最终证据另见交付记录。
- 独立代码复核确认 Pin 来源与高清候选逻辑不变；最近 wrapper 校验拒绝邻近或嵌套不同卡片。官方 Card 样式、搜索布局、采集接收协议与入库流程均未修改。
- 隔离站点与合成图片不等于真实登录账号／完整站点实验分支、OS 物理跨窗投递或 Mac 原生验收。脚本由 Rust 嵌入，需重新构建并启动桌面后端才生效；没有替用户重启、安装或发布应用。

## 交付记录

- `cargo build --offline --example explorer_smoke --target-dir target-local-classification`（从 `apps/desktop/src-tauri`）成功。`node --experimental-strip-types scripts/pinterest-feed-drag-native.test.mjs`（从 `apps/desktop`）最终 **10/10、exit 0**；官方 wash／渐变、详情与透明层均带出高清图片和 Pin 来源，私有 start/end 通知、标准文本格式传入主 WebView 后正式解析均通过；正文／按钮／弹层不产生图片采集。
- 原生证据 `apps/desktop/.tmp/pinterest-feed-native-1793724882515/result.json`；测试强断言 EXE 嵌入当前拖图脚本，SHA256 `552c053567445d0fbcf93636575d8078f029da20ea06f4f095980a59f69903a5`。自身测试进程退出并清理，未触碰用户应用。
- mutator 共枚举 178 位点，定向执行域名条件、装饰层边界、同 Pin 身份 3 个变异，**3/3 杀死**，由可见行为断言失败而非语法或超时。仅是定向范围，不报全文件 mutation score。工具命令／覆盖转换与输出见 `.tmp/pinterest-feed-drag/quality.md`；研究／原生／测试细节分别保留在同目录日志。
- 更新 PROJECT 与探索协议，检查最终差异和语法；本次产品只修改共享网页拖图脚本。按已启用 ub-mode 将本次八个文件提交至 dev 并推送既有 origin/dev；不夹带并行任务修改，不新增工作树，保留临时红绿证据供真实站点复核。
