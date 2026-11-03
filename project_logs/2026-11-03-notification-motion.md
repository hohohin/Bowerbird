# 新消息卡槽入场动效

用户明确要求现有消息弹出增加闪烁和从右向左“卡进卡槽”的感觉。本轮仅调整已确认通知的入场表现，保持布局、历史、4 秒收起与导航行为；原网页直接引用正式组件，可用“模拟完成”检视。

1. 读取当前 PROJECT、视觉与错误提示规范、架构复用入口，以及正式 NotificationBell 和对应隔离夹具。UI/UX 定向检索命中减少动态效果及局部动画规则；继续按 ub-mode 实施。
2. 在真实组件先复现失败：原动效只有向下轻移，缺少水平卡入。新增动画以 420ms 完成右侧 48px 入场、3px 越位、1px 回弹和归位；250ms 起边缘短闪两次，正文不跟随闪烁。
3. 用通知 ID 给新消息建立独立动画生命周期。未阅读时后续消息重播；已阅读消息与手动历史不因新到达消息重播。没有修改消息 reducer、4 秒计时或任务导航逻辑。
4. 动效采样最初未保留已结束短闪的动画句柄，反向取样读到静态透明度；修正测试采样后通过。正式动效、原通知行为、真实 App 回归全部通过，并检查深浅色截图。开启减少动态效果时水平移动和短闪均关闭。
5. 完整 TypeScript 与独立 Vite 生产构建通过，保留原有大 chunk／混合导入提示。只核验源码与合成 IPC，未调用模型、操作用户资料库或发布安装包。

验证命令（在 `apps/desktop`）：

- `node scripts/notification-bell-motion-ui.test.mjs`
- `node scripts/notification-bell-preview-ui.test.mjs`
- `node scripts/notification-bell-app-ui.test.mjs`
- `node node_modules/typescript/bin/tsc --noEmit`
- `node node_modules/vite/bin/vite.js build --outDir .tmp/notification-bell-motion-build`

质量范围：Crapper 扫描通知组件，11 个函数最大圈复杂度 8；Coverage／CRAP 为 N/A，不声称 CRAP 小于 10。Dryer 0.8 无重复候选。Mutator 在冻结副本仅反转本次新增的通知身份比较，真实“后续消息重播”断言成功杀死该变异；扫描的其余 59 个候选未执行，CSS 不在该工具支持的变异范围。工具沿用本地 TypeScript 解析器与限定快照的顺序执行适配，没有修改正式源码或工具安装。执行后冻结副本与正式组件 SHA256 一致。

动效截图与构建日志在 `apps/desktop/.tmp/notification-bell-motion/`；定向变异日志在 `.tmp/notification-bell-motion/logs/`。确认构建完成并核验绝对路径后删除本轮可重建的临时构建输出，保留日志与截图。本轮没有创建额外 Git 工作树，其他聊天的工作区修改保留；使用独立暂存区提交本轮代码、测试与文档。

原 17922 预览服务已停止；重新启动本机 Vite 后，实际 HTTP 请求确认通知 CSS 和消息身份代码都是本轮版本。原预览链接 `/scripts/fixtures/notifications-scrollbars/preview.html` 的“模拟完成”可查看动效；该页仍只用于通知与滚动条展示。
