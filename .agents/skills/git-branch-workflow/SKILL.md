---
name: git-branch-workflow
description: >-
  Bowerbird 工程开发与发版的 Git 分支、工作树及版本标签管理规范。
  当用户进行开发、工程开发、发版、打包发布、功能实现、缺陷修复、并行任务建工作树、合入主干或清理分支时触发。
---

# Git 分支与工程开发工作流

遵循「主干开发（`dev`）+ 带注释发布标签（`v<版本>`）+ 短期分支用完即清」，避免分支与工作树积压。

## 分支角色

| 分支 | 定位 | 约束 |
|---|---|---|
| `dev` | 唯一日常开发主干（`origin/HEAD` 默认分支） | 仓库根目录固定检出 `dev`；禁止在外部临时工作树中检出 `dev` |
| `main` | 最新已公开发布且验收通过的正式版源码 | 禁止直接提交或开发；仅在发版验收通过后从冻结提交快进（`--ff-only`） |
| `mac` | 历史 macOS 归档分支（`origin/mac@13fdfdb2`） | 冻结归档，停止新增业务提交；未经用户明确确认不得推送 |
| `feature/*` · `fix/*` · `codex/*` | 短期任务分支 | 单一任务使用，合入 `dev` 后当场删除 |

## 日常工程开发流程

### 1. 开工前
- 在仓库根目录确认当前处于 `dev` 且已对齐远端：`git fetch --prune origin`。
- 需要隔离环境或并行开发时，从最新 `origin/dev` 切短期分支，**工作树必须建在仓库根目录之外**（例如 `D:/H/Project/Bowerbird-worktrees/<topic>`），严禁建在仓库内 `.tmp/` 或 `.claude/worktrees/`。

### 2. 开发与合入
- 保持分支短生命周期；涉及云端或未启价能力时，通过默认关闭开关／目录门控实现，完成关闭态验证与部署门禁后尽早合入 `dev`，避免长期孤立分支与主干脱节。
- 按 [AGENTS.md](../../../AGENTS.md#常用验证命令速查) 执行对应范围的构建与定向测试，确认无回归后再合入 `dev` 并推送 `origin/dev`。

### 3. 谁建谁收（合入后必做）
任务合入 `dev` 后，**当场完成清理**，不得遗留到下次：
1. 若使用了独立工作树，先检查其 `git status --porcelain`（确认无未提交、未跟踪或需保留的忽略文件），再移除：`git worktree remove <外部工作树路径>`。
2. 删除本地短期分支：`git branch -d <短期分支>`。
3. 若该短期分支曾推送远端，顺手删除：`git push origin --delete <短期分支>`。

### 4. 用标签存档，不用分支存档
- 放弃但需留底的实验或历史检查点，先打带注释标签并推送，再删除分支：
  ```powershell
  git tag -a archive/<名称> <commit-sha> -m "Historical checkpoint: <说明>"
  git push origin archive/<名称>
  git branch -D <旧分支>
  ```

## 多 Agent 并行开发流程

采用「根目录只做总控合入 + 每个 Agent 独占外部工作树 + 串行逐个合入并即刻回收」：

1. **派工前切边界**：根目录保持在干净的最新 `dev`，不让多个 Agent 抢写根目录；按模块／文件边界拆任务，避免多人同时重写同一核心文件；涉及 SQLite／Supabase 编号迁移时预先分配迁移号。
2. **独占外部工作树开工**：所有并行任务从最新 `origin/dev` 拉起，工作树统一建在仓库外同级目录（如 `D:/H/Project/Bowerbird-worktrees/<任务>`），各自只在本工作树内修改、测试、提交，不碰根目录，不直接推 `dev`：
   ```powershell
   git fetch origin dev
   git worktree add -b codex/<任务A> D:/H/Project/Bowerbird-worktrees/<任务A> origin/dev
   ```
3. **串行逐个合入**：禁止把多个长期分叉分支搅在一起做大合并；谁先通过验证谁先合入 `dev` 并推送 `origin/dev`，后完工的分支先基于最新 `origin/dev` 执行 `git rebase origin/dev` 消化冲突、重跑验证后再合入。
4. **即刻回收**：每合入一个分支并推送成功，当场检查该工作树状态并移除工作树、删除本地及远端短期分支；对未采用的对比方案，有留底价值先打 `archive/<名称>` 标签再删，无留底价值直接删除。

## 正式发版流程（先公开发布与回读验收，再同步 `main`）

客户端自动更新依赖 CDN／R2 更新清单与 Tauri 验签，而非 Git 分支触发。**禁止在发版验收前提前推送 `main`；仅内部 QA／测试包（未切换公开自动更新）不动 `main`，也不打正式 `v<版本>` 标签。**

1. 在 `dev` 上完成验证、存档提交并推送 `origin/dev`，记录冻结构建源码提交 `<release-sha>`。
2. 基于 `<release-sha>` 打包签名，上传并切换官网安装包及客户端自动更新清单，完成 CDN／公网完整回读与 Tauri 验签。
3. **确认公开发布无误、无需回滚后**，打带注释发布标签并将 `main` 仅以快进方式指向 `<release-sha>`：
   ```powershell
   git tag -a v<版本> <release-sha> -m "Windows <版本> public release source"
   git merge-base --is-ancestor main <release-sha>
   git branch -f main <release-sha>
   git push origin main v<版本>
   ```

## 收尾核验

每次合入、发版或清理结束后执行体检：

```powershell
git fetch --prune origin
git branch -vv
git worktree list
```

**合格标准**：本地仅保留 `dev`、`main` 及当前真正在进行的 0–2 条短期分支；`git worktree list` 无已完工或失效的孤儿工作树；根目录处于 `dev` 且已跟踪文件干净。
