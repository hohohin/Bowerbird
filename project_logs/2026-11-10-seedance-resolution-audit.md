# Seedance 规格巡检：2026-11-10 部署与验收

用户明确回复“确认部署”后，2026-11-10 23:46:29（北京时间）完成 VPS Worker 切换，随后读回真实巡检结果。产品决定以 [PROJECT](../PROJECT.md) 为准，行为与本机验证见 [Seedance 专项](../dev-doc/SEEDANCE-2.5-INTEGRATION.md#2026-11-10建卡免核验与后台每日规格巡检)。桌面免建卡核验是已实现源码，本次未打包或发布桌面安装包。

## 范围与现役证据

- 仅覆盖 `src/cloud-generation/seedance-resolution-audit.ts`、`src/main.ts`、`src/cloud-generation/main.ts`；两个入口与实际线上源码的差异只有巡检导入和启动调用。部署前、切换前及验收后 generation／understand／agent／chat 活动队列均为 0，没有取消或重投用户任务。
- 以实际现役镜像 `sha256:a18a32e25663e9ff581c7b476889ee18fd48a469fe17ea4e0186492ac7ef284a` 叠加目标文件。新镜像 `sha256:cd4fd8c7093df2a34f96462ab7d42387d6a81e37d9dfd4636f4004139e2734ed`，标签 `bowerbird/generation-worker:seedance-audit-20261110`；Compose 现役 `bowerbird/generation-worker:local` 指向该镜像。
- 容器 `agent-worker-generation-worker-1` running、restart=0。三个文件容器／宿主机／冻结清单 SHA-256 一致；环境文件、全部环境键值、Compose、挂载全部字段、资源／安全限制、启动命令、网络及官网 symlink 均保持。共享 `video-contract.ts` 与原镜像哈希一致。
- 首次 `seedance_resolution_audit` 的 `checkedAt=1794325589667`（北京时间 23:46:29.667），`status=unchanged`，`expected`／`observed` 同为 `1080p,480p,720p`；实际访问固定官方公共文档。随后由进程内 24 小时间隔执行，定时与去重已通过隔离测试，未将尚未经过的下一个 24 小时记为实测。
- 未部署 Edge、数据库、官网或其他 Worker 模块；未修改模型、价格、密钥、任务及客户端配置。巡检不调用生成接口，不产生生成任务或模型计费。

## 验证与限制

新巡检候选镜像在断网、只读、无凭据容器中 3 项通过。视频回归使用同一份本机测试分别运行原生产镜像与候选镜像：均 8 项通过、1 项失败，失败同为纯音频参考的 `video_references_required`。该测试对应本机尚未部署的音频契约，线上原契约不支持；本次未覆盖契约，也没有新增失败。不能把本机源码 12 项通过等同于生产候选 12 项全通过。

此前本机桌面 UI、28 项视频测试、桌面完整类型检查、Worker 生产类型检查通过。Worker 全量类型检查有三个既有测试声明错误，见专项；本次没有修改无关声明。公开规格一致不代表所有用户本机 Dreamina CLI／账号能力或各分辨率的真实生成已验收。

构建首次使用裸镜像 ID 作为 Dockerfile 基础引用未成功，尚未切换服务；改为对同一已验证镜像加本地固定回滚标签后构建成功，未拉取或替换基础依赖。

[脱敏部署证据](2026-11-10-seedance-resolution-audit-evidence.json) 包含冻结文件哈希、候选测试、切换及线上巡检结果。临时脚本和日志在 `.tmp/seedance-resolution-deploy`；服务器永久回滚备份在 `/opt/bowerbird/deploy-backups/seedance-resolution-20261110`。记录不含账号凭据或用户生成内容。

## 回滚

确认相关活动队列为空后，恢复备份 `before/src/main.ts` 与 `before/src/cloud-generation/main.ts` 到 `/opt/bowerbird/agent-worker` 对应位置，并删除本次新增的 `src/cloud-generation/seedance-resolution-audit.ts`。将 `bowerbird/generation-worker:rollback-seedance-audit-20261110`（上述 a18a32e… 原镜像）重新标记为 `bowerbird/generation-worker:local`，在 Worker 目录执行原 `docker compose --env-file .env.generation -f compose.generation.yml up -d --no-build generation-worker`。核对原镜像、运行状态和配置；不恢复或改动环境、数据库、任务、计费与官网。后续若已有其他部署，应先按新部署记录合并回退，不能直接覆盖现役新增功能。
