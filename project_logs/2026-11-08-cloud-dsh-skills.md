# Cloud DSH Skill 服务端迁移与部署

用户明确要求修正并部署。现行架构决策见 PROJECT.md，本记录保留实施证据。

## 变更

- H3 Skill 从桌面源码迁至 `apps/agent-worker/src/skills/text/h3-video-prompt/SKILL.md`；同目录增加 text-editor 方法。客户端发闭集标识、参数／用户要求与 source，不发送方法正文。
- Worker 的 `cloud-text-skills.ts` 验证选择信封，读取 VPS 文件；新旧 H3 请求均使用服务端方法，旧客户端方法正文不传入模型。普通用户要求原样处理；现有图片／HTML Skill 继续 `read_skill`。
- 首次模型执行前保存方法正文、版本、参数和 SHA-256；恢复验证快照哈希，保持已冻结方法。纯文字计费、工具禁用、原任务恢复和结果回填边界不变。
- Compose 新增 `BOWERBIRD_TEXT_SKILL_DIR=/app/text-skills` 与 `./src/skills/text:/app/text-skills:ro`。维护文件更新后新任务读取，无需重新打包桌面或重建镜像。

## 发布

- 北京时间 2026-11-08 **11:09:50** 切换，11:09:51 首次核验通过。部署前 generation／understand／agent／chat 四队列均为 0。
- 原镜像：`sha256:4e732efa289246a064883e997db99bac88ccdab6c4dbbf5dff4bed2afe6ba6b3`。
- 新镜像：`sha256:5d5190c9c6768203ac96dbd57827180ed40386d6b63e730f4bd176d0fcb7624c`。
- H3 Skill SHA-256：`2d32547d50469a217746c52f3a01ef7f2768eed9593dc39be61b6d31f49744c8`。
- text-editor SHA-256：`5c2dc5eb45de53d0351d6102066225d2a8a5e5640aa75b4dfcf860246898778d`。
- 仅覆盖 processor、text-rewrite、cloud-text-skills、两份 Skill，外加 Compose 两行挂载配置。候选由现役镜像叠加，不携带本机其他未部署变更（包括文本长度限制放宽）。未部署 Edge／SQL、未修改密钥／权限／价格／资源限额。
- `/opt/bowerbird/deploy-backups/cloud-skills-20261108/` 保存原源码、Compose、清单和镜像身份；旧镜像标签 `bowerbird/generation-worker:rollback-cloud-skills-20261108`。回滚应先确认队列及新协议任务状态，恢复备份源码／Compose 和旧镜像；旧 Worker 不理解新标识请求，不能直接接手尚未执行的新标识任务。不得删除任务或账本。
- 本地操作清单／候选测试／队列及部署日志：`.tmp/cloud-skills-20261108/`；VPS 同次候选与证据 `/tmp/bowerbird-cloud-skills-20261108/`。

## 验证与边界

- VPS 候选断网、只读、无生产凭据的 22 项测试通过：H3 标识调用、旧客户端正文丢弃、拒绝未知方法及矛盾参数、编辑器用户要求分离、文件更新、快照篡改拒绝、模型前崩溃后的方法冻结、已完成结果不重复执行，以及统一图片／HTML 执行与恢复。
- 卡片／底部创作框两套正式组件模拟 IPC 测试通过，客户端请求只有标识参数，直接回填、三模式、恢复、切号、跨项目、零额外建卡和手动生成保持。桌面 `tsc --noEmit` 通过。
- 文本编辑 Agent 正式组件回归通过，新增断言确认 Cloud 只传 text-editor 标识和用户要求；本机 Codex、上下文、写回／撤销、取消、切号及原请求恢复保持。
- 本机 Worker 全量类型检查被既有 `video-audio-probe.test.ts` 的 `execFileSync` 环境声明缺失阻塞；本次新增代码类型错误已排除。本机完整 processor 测试被既有 Skill bundle 哈希不匹配阻塞，改用现役镜像验证部署候选，没有修改无关 Skill 哈希。
- 现役原语言／官方模式、旧版映射、统一 registry、聊天模块、只读挂载和 5 个文件哈希核验通过；Worker 正常运行、restart 0，启动事件无错误。没有真实付费模型／GPU 调用，不把模拟测试当作提示词质量验收。
- 11:12:20（北京时间）再次核验通过，新增 `agent_health` 健康事件，无错误／重启；最终 diff 空白检查通过。
- 客户端源码已改，但本轮未发布桌面安装包。旧安装版仍携带旧正文；服务端已忽略并使用 VPS 方法。完整停止发送需客户端升级，后续仅修改方法文件不需桌面升级。
- 自动审批拒绝整份 Worker 源码归档跨环境下载；改为备份与验证留在 VPS，未导出该归档。首轮候选构建将摘要误作仓库名，被镜像源拒绝；改用已核验的本机镜像标签后断网构建通过，未影响现役服务。
