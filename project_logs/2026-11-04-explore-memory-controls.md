# 探索记忆与 Pinterest 控件后续

## 行动与原因

1. 按 ub-mode 读取当前项目、架构／复用地图、探索及引导契约。定位到地址已经写入 `bowerbird.explorer.lastUrl`，但顶栏未读取；引导还有每次开关都强制重置默认页的分支。复用现有键与地址校验，不新建浏览历史系统。
2. 新增真实 App 隔离回归，先得到预期失败：记录为 Pinterest 搜索页，实际打开默认小红书。修复为首次打开读取本机地址；收起继续复用原生页面，引导也不再强制导航。地址读写集中到现有 `sourceDiscovery` 模块，非法／含凭据 URL 不替换记录，存储不可用不影响打开。
3. 用户追加隐藏原生保存控件与细化把手。核对公开 Pinterest bundle `24589-25429406d97fffb8.mjs` 的 BoardSelectionDisplay：实际标识是 `PinBetterSaveDropdown`／`PinBetterSaveButton`。只隐藏这两类控件，不按“保存”文字匹配。追加测试在旧实现分别因按钮仍显示和把手仍为 24px 失败，随后修复通过。
4. 探索局部 CSS 将把手垂直居中，宽度 24→14.4px；SVG 横向同比缩放、握柄／退出图标适配，素材库原尺寸保留。页签、探索外壳及加载区共用 surface token，深浅色逐一核验。
5. 进一步验证原生实际地址，发现 `history.pushState` 后旧 status 事件为空：`.tmp/pinterest-layout-native-1793762138654/result.json`（相对桌面目录）。增加原生只读 URL 观察，以独立 location 事件同步 SPA，不误改加载指示，也不开放远程 IPC。500ms 采样、仅变化时发给主窗口；创建后仅一个任务，复用／隐藏不增生，关闭或读取失败退出。
6. 跑最终浏览器、WebView2、类型和构建；核对运行 EXE，而非仅判断前端热更新。PID 54956 在 11:18:34 自动启动，当前默认 debug EXE 包含 location 事件和完整最终 Pinterest 注入脚本，SHA256 `52079a4c7ca306518c6585b079b7cdca2fc5a8ce4ceb7cbe5d539ca3db25ff6b`；未再次手动重启。
7. 同步 PROJECT、探索／引导文档与状态复用地图，仅提交本次改动。其他聊天有同时暂存／提交的创作界面修改，未混入、覆盖或撤销；本轮没有创建 worktree，没有删除其他任务的工作目录。

## 验证结果

- `source-discovery.test.mjs`：6/6，包括有效地址、无记录、无效／凭据记录、存储拒绝，全部通过。
- `explore-memory-ui.test.mjs`：正式 App、原生事件模拟、关闭重开无重新导航、活动引导、浏览器资料保留后的新实例恢复、无效记录回退，通过。启动本身不自动打开探索。
- `pinterest-search-ui.test.mjs`：明确发起搜图仍走正确入口，详情／右键、多选、路由／选择保留、登录续办、一次交付、取消与迟到事件回归通过。
- `explore-handle-ui.test.mjs`：居中、14.4px、深浅色同底色、拖动／键盘／退出与素材库原握柄回归通过。截图在 `apps/desktop/.tmp/explore-handle/`。
- `pinterest-chrome.test.mjs`：隐藏两类原生控件、保留其他按钮、SPA 动态插入和非 Pinterest 页面不受影响；既有零占宽滚动／36px 导航回归通过。
- 最终 `pinterest-layout-native.test.mjs` 通过：`apps/desktop/.tmp/pinterest-layout-native-1793762340336/result.json`，包含真实 SPA 搜图／Pin／后退地址通知、原生控件隐藏、调宽、分页、自动传图。示例由 `cargo build --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir apps/desktop/src-tauri/target-local-classification --example pinterest_search_smoke` 构建。
- `pnpm exec tsc --noEmit`、`pnpm exec vite build` 通过；Rust／Vite 保留既有 unused、chunk 大小及混用动态导入提示。

## 质量与验收边界

crapper 用实际 Node V8 覆盖率度量 `sourceDiscovery.ts`：新增两函数覆盖率 100%，CRAP 均为 3，全文件最高 8.4。dryer 无 0.8 以上重复候选。官方 mutator 的存储有效性守卫变异被杀死；空值运算 `??`→`||` 存活，经边界审查属于等价变异（Storage 返回 string／null，空字符串两种写法都得到空字符串），没有伪造不符合 Storage 契约的值来追求分数。证据 `.tmp/explore-followup/quality/`。Rust 度量换用本机现有 Rust grammar，新增观察函数 CC 4；没有原生覆盖率／CRAP 评分，以真实 WebView2 红绿行为验证为准。

验证使用合成站点／IPC 和隔离资料，未上传用户图片或修改其素材库。记忆是上次网址，站点临时结果是否能在冷启动重建由其自身决定；只在未销毁的浏览器会话内保留原页面状态。本次更新本机开发实例与源码，不发布安装包；Mac 与真实账号全部页面变体仍待验收。
