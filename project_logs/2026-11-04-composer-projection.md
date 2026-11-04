# 全息创作框接入与浅色方案

- 需求：先将本对话确认的无框全息稿接入共用创作框，再加强浅色点阵、分层景深和素材提示。
- 开工：读取 PROJECT、UI 规范、开发计划/复用地图及项目画板契约；检查已有 optical HUD、真实编辑器、项目菜单和回归脚本。
- 保留：使用 CreationBoard、ProseMirror、TacticalSelect 和真实引用/发送链路；不改变生成 provider、计费、项目归属或原有并发工作。相关文件改前副本在 `.tmp/composer-projection-baseline`。
- RED：新增真实 App 隔离回归 `composer-projection-ui.test.mjs`，在空输入仍为多行高度处如预期失败。沙箱首次阻止 localhost / pnpm junction；获自动批准后重跑才得到行为 RED。
- 实现：独立装饰层共用弧线下方的羽化 mask；点阵节奏和三层叉矩阵视差；真实选区窄块光标。编辑器及输入法始终保留原生选择和 ProseMirror 行为。
- 工具：当前会话无 crapper、dryer、mutator 工具，未编造评分；以类型检查、行为回归和人工 diff 审阅替代可执行部分。
- 布局核验：空输入一行、随换行增高；底栏约距底部 4%。发现窄画板中原左轨占宽挤压视频模型后，将紧凑窗口的左轨放到输入区左侧，让参数保留完整宽度。项目菜单沿原 listbox/combobox 与键盘状态，仅更换投影外观。
- 浅色设计：另制「银白显影」演示，提高蓝灰方点的明暗变化、让远层小叉位于雾化遮罩之上，保持三层不同模糊／视差，并取消对话模式隐藏素材提示的旧条件；演示没有自动替代实装浅色基础。羽化距离仍可调整。
- GREEN：`composer-projection-ui.test.mjs`（含真实 ProseMirror 中文 IME、窄块选区光标、单行增高、模式选中、深浅色点阵、项目菜单、减少动态）；`creation-caret-ui.test.mjs`；`composer-hud-ui.test.mjs`（项目／品牌菜单、引用顺序与 Backspace、主屏／画板、900/1100/1440/1920 视频参数与高对比）；`composer-header-ui.test.mjs`（1440/900/640、两主题、历史与收起）；`library-creation-parity-ui.test.mjs`（Tab、双击、缓存缺失素材、异步顺序、草稿与画板手势）；TypeScript `--noEmit`。
- 旧测试只更新被本次视觉决策替代的断言：固定多行高度、切角边框、提示位置／文字与添加按钮；业务断言继续运行。其他工作已有的测试和代码改动留在工作区。
- 演示检查：1024/736/460/320 宽度无溢出；3 层／窄屏 2 层叉矩阵、呼吸闪烁、鼠标视差、减少动态静止、输入增长、IME、项目选择、引用显示、收起保稿均通过，无页面错误。实装截图见 `apps/desktop/.tmp/composer-projection/`，交互演示在本次对话可查看。
- 边界：检查使用真实 React 组件和隔离 IPC fixture，没有调用付费生成、改写用户库、制作安装包或部署。只提交本任务差异，不清理或提交其他未完成工作。
