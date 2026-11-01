# 2026-11-01 预览服务退出与文件监听

## 证据与根因

查阅对话「调查nodejs javascript runtime cpu占用高并且有两个进程的原因」（`01a194ba-f659-7ec3-bc6e-29ccaefae05c`）确认：PID 68208 的 `library-connections-preview.mjs` 和 PID 4616 的 `.tmp/library-console-preview/structure-server.mjs` 分别监听 17871／17864，父进程已退出，历史采样每个约 11% 全机 CPU、约 19,750 句柄。用户已经关闭这两个进程，本轮无法补采原故障 CPU 调用栈，不把旧 CPU 热点当成已定位的事实。

本轮确认两处代码缺陷：

- Vite 服务没有父进程生命周期管理。仅处理 SIGINT／SIGTERM，或依赖 stdin 关闭，不能覆盖脱离终端的子进程。
- 本地 Vite **5.4.21** 的 `mergeConfigRecursively` 跳过 `null`。`resolveConfig({server:{watch:null}})` 实际得到默认 `watch.ignored` 对象；关闭 HMR 不等于关闭 watcher。旧结构预览本来就使用默认全树监听，庞大的 `.tmp` 构建／截图／缓存目录也会进入监听范围。

## 操作与修复

1. 按 ub-mode 先读当前约定、启动脚本和历史对话，独立复核 Vite 合并／watcher 创建／restart 时序。没有停止用户现有应用或枚举终止其他 Node。
2. 先复现配置红灯；隔离 detached 子服务、无 IPC、`CI=true` 时，父进程退出 6 秒后旧服务仍存活。`CI=true` 用于关闭 Vite 的 stdin-end 捷径，覆盖不依赖终端管道的真实启动方式；不声称重现历史 CPU 异常。失败测试的自建 PID 已清理。
3. 新增共用 `scripts/vite-lifecycle.mjs`。在配置解析后、watcher 创建前恢复显式 `watch:null`；服务每秒探测启动时父 PID，仅 ESRCH 判定不存在，权限错误不误退出。父退出、IPC 断开及退出信号触发关闭，保留 3 秒强退期限；正常 `server.close`／restart 只释放本实例监听和计时器，不退出调用方。`vite preview` 复用同一清理。
4. 正常开发忽略 `.tmp` 生成物，保留源码监听；独立连接／对话预览关闭 watcher。两个 `configFile:false` 拖出预览显式接入插件并关闭 watcher，移除重复信号处理。旧 structure-server 仍加载正式 Vite 配置，直接受共用修复覆盖，不批量改写历史临时服务。
5. 使用隔离浏览器与临时端口验证预览仍可用，检查构建。没有新增依赖、调用付费服务或写入用户素材库。crapper／dryer／mutator 工具不可用，以行为回归和独立代码审查替代；不清理其他任务工作树或临时产物。

## 验证

- `node --test scripts/vite-lifecycle.test.mjs`：**7 项通过**；父正常退出／强制终止及端口回收、父仍存活时 IPC 断开、关闭钩子卡死的 3 秒兜底、显式关闭 watcher、生成目录排除与真实源码监听、listen 前后关闭及 restart 后 HTTP 和监听清理。结束后按测试脚本路径只读核对，无测试 Node 遗留。
- `node scripts/library-connections-ui.test.mjs`：**11 场景通过**，包括连续分组、集合操作、菜单、键盘、深浅主题与窄屏。
- 独立预览空闲采样：watch 为 null、监听目录 **0**；约 **3010ms** 内 `process.cpuUsage` 增量 **0ms**。这是一次短时空闲验证，不等于旧异常 CPU 调用栈已解释。
- `vite preview` 对生产构建 HTTP 返回 200，关闭后 SIGINT／SIGTERM／SIGHUP／disconnect 监听数量回到基线。
- 完整 TypeScript、独立 Vite 生产构建通过，保留原有大 chunk 提示。

修复仅影响后续启动的开发／预览 Node 服务。没有制作安装包；应用关闭、开发启动器退出、浏览器标签关闭是不同生命周期，浏览器暂时没有连接不会结束仍在使用的开发服务。原生进程验收在 Windows 进行，Mac 行为尚未实测。本轮保留为本地提交；沿用此前推送目的地仍待授权的边界，未再次尝试推送。

参考：[Vite 5 文件监听选项](https://v5.vite.dev/config/server-options#server-watch)、[Node process 文档](https://nodejs.org/api/process.html)。实际行为以本机锁定版本与测试为准。
