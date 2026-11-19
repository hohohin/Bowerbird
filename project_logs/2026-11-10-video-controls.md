# 视频控件确认稿实装

用户确认独立预览后接入正式播放器；本轮是桌面源码修改，不是安装包发布。现行决策见 PROJECT.md。

## 实现

- `VideoPlayer.tsx/.css`：完整等比居中，允许左右留白；宽度按控制空间确定，胶片／播放／操作分区，音量使用细线方柄，窄容器按组排布。
- `VideoTrimTimeline`：同一胶片的双端手柄裁剪、区间外压暗，保留秒数输入和键盘替代。另存、覆盖、停止解码后替换、失败恢复及回调身份沿用现有链路。
- `videoFineScrub`：时间轴和端点共享按住 400ms、落点 3–12px 内轻拖的四倍精度；快速拖动不误触，切换／松手不回算旧位移，取消／失焦退出。去掉独立细调按钮；Shift＋方向键仍以 0.01 秒步进。阈值为本应用参数，不宣称 iOS 官方数值。
- 倍速复用 `TacticalSelect`，菜单悬浮，打开／关闭不改变画面或控件几何；可选 `portalContainer` 支持全屏顶层，默认调用方行为不变。`Lightbox` 对已打开下拉的 Esc 让路。
- 复用入口：素材库／详情 `AssetDetail`、画板与媒体预览 `Lightbox`、本机对话 `LocalChatPanel`、Agent 详情 `WorkflowAgentDetail`、复刻 `ReplicationTaskPanel`。复刻 CSS 删除旧比例限宽和自动视频高度覆盖。
- 保留确认预览；新增 `scripts/fixtures/video-player-live` 直接加载正式组件，宿主只负责页面布局，不注入播放器覆盖样式。模拟回调不写真实素材。

## 验证

- `video-fine-scrub.test.mjs`：3 项触发、增量精度、防误触测试通过。
- `video-player-redesign-ui.test.mjs`：实际鼠标长按、四倍灵敏度、释放无跳变、快速拖动、失焦、裁剪手柄、宽窄菜单零位移通过。
- `video-player-ui.test.mjs`：真实合成视频首／尾帧像素、单帧短片、尾帧重试／去重／关闭取消、空格、画板入口、宽窄比例、定位和释放通过。
- `video-trim-ui.test.mjs`：裁剪范围／键盘、另存、落点保存失败后不重复编码、失败覆盖保留原件、替换前释放源、重载和窄窗口通过。
- `video-player-upgrade-ui.test.mjs`：音量／倍速、菜单 Esc 不关闭媒体、全屏菜单实际可选、胶片比例／缓存／修订、原尺寸截帧的素材库及画板目的地、加载失败恢复、详情嵌入及键盘归属通过。
- `tactical-select.test.mjs`：6 项原菜单解析／导航／位置逻辑通过。
- 桌面 TypeScript 和独立 Vite 构建通过，保留既有大 chunk、动态／静态混合导入及依赖 PURE 注释警告。无 Rust／Cloud 变更；未运行真实用户库写入、未发布安装包，Mac 原生待验。
- 旧 UI 测试补齐当前源码所需路径别名／主题，旧细调按钮和原生 select 断言换为新交互；旧“播放器跟随视频比例无黑边”改验完整 contain 及真实源比例。浏览器媒体时间存在微秒舍入，松手比较采用 0.00001 秒容差。

正式截图及隔离产物：`apps/desktop/.tmp/video-player/`、`video-upgrade/player/`、`video-trim/`、`video-redesign/`；构建 `.tmp/video-player-implementation-build/`。原播放器基线副本 `.tmp/video-player-implementation/`，仅供增量对照，不整份覆盖后续源码。
