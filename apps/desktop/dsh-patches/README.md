# 本机 DSH 建卡参数补丁

适用于 DeepSeek Harness **0.2.2-rc.1** 的 Messages adapter。上游 tag 为 `dsh-v0.2.2-rc.1`，源码提交为 `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`。Bowerbird 托管启动的 CLI/web 子进程使用内置 `local_chat_dsh_compat.cjs`，在加载官方 adapter 时核对模块文件与版本，匹配后在内存中应用下述补丁。当前纳入的官方 JS 的 SHA-256 为 `955dc7bc7ca6c857ff4a7e373b87c143b96a4c43fc80325b67dc0982600dcc75`。其余版本或构建使用宿主原生解析。外部已运行的 3080 宿主由原程序管理。

## 在已安装版本上验证自动兼容

以下为专项维护命令。测试使用内存里的 SSE fixture 和官方 `DeepSeekAdapter.stream`、`BlockAssembler`，可在仓库根目录运行。用户走桌面托管启动入口时，启动器自动传入预加载模块。

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:/Tools/DSH/DeepSeek Harness.exe' --expose-internals --require "$pwd/apps/desktop/src-tauri/src/commands/local_chat_dsh_compat.cjs" "$pwd/apps/desktop/dsh-patches/test-card-arguments.mjs" --installed 'D:/Tools/DSH/resources/app.asar/dsh'
```

## 手动构建上游源码补丁的独立比对样本

以下 PowerShell 命令从 Bowerbird 仓库根目录运行，使用 Node 24.9 以上、Git、npm 及本机已安装的 Windows x64 DSH 0.2.2-rc.1。从安装包解出的 CLI 与所有 provider 依赖保持同版，仅在**新建的副本**内编译一个 adapter。目标目录已存在时换一个空目录，以便保留先前候选。

```powershell
$patchDir = (Resolve-Path apps/desktop/dsh-patches).Path
$archive = 'D:/Tools/DSH/resources/app.asar'
$candidate = Join-Path $env:TEMP ('bowerbird-dsh-' + [guid]::NewGuid())
$sourceTree = Join-Path $candidate 'source'
$unpacked = Join-Path $candidate 'unpacked'
git clone --depth 1 --branch dsh-v0.2.2-rc.1 https://github.com/deepseek-ai/deepseek-harness.git $sourceTree
if ($LASTEXITCODE -ne 0 -or (git -C $sourceTree rev-parse HEAD) -ne '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db') { throw '源码版本不符' }
git -C $sourceTree apply (Join-Path $patchDir 'dsh-0.2.2-rc.1-card-arguments.patch')
if ($LASTEXITCODE -ne 0) { throw '补丁未应用' }
npx --yes --package=@electron/asar@4.0.1 asar extract $archive $unpacked
if ($LASTEXITCODE -ne 0) { throw '解包失败，请确认 app.asar.unpacked 与 app.asar 同目录' }
$runtime = Join-Path $unpacked 'dsh/node_modules/@deepseek-ai'
$adapter = Join-Path $runtime 'dsh-llm-deepseek'
if ((Get-Content "$adapter/package.json" -Raw | ConvertFrom-Json).version -ne '0.2.2-rc.1') { throw '发行版适配器版本不符' }
npx --yes --package=esbuild@0.21.5 esbuild "$sourceTree/packages/llm/llm-deepseek/src/index.ts" --bundle --platform=node --target=node24 '--external:@deepseek-ai/*' --packages=external --format=esm "--outfile=$adapter/lib/index.js"
if ($LASTEXITCODE -ne 0) { throw '适配器编译失败' }
$env:DSH_HOME = Join-Path $candidate 'home'
node "$runtime/dsh/lib/bin.js" web --no-open --port 31897
```

上例使用全新的 DSH home，适用于隔离验收。需要通过 Bowerbird 使用时，让 Bowerbird 和候选 DSH 进程使用同一个 DSH home（桌面托管 preset 与每轮握手文件位于该目录），在本机 DSH 设置里填写候选进程打印的连接地址并登录测试账号。端口 31897 如有占用请换空闲端口。终止候选 host 并重新连接原 3080 地址可恢复原运行路径。此流程未替换系统 DSH、重签 Electron 或改动原始会话。

## 回归与证据

`test-card-arguments.mjs` 接收已打补丁的上游源码根目录，使用真正的 translator 和同版 `BlockAssembler`。完整 DSH 开发 checkout 用其工作区依赖运行。仅解包验证时，可在上述新建源码副本中将发行 runtime 的依赖目录链接到源码包的依赖解析位置，然后运行：

```powershell
New-Item -ItemType Junction -Path "$sourceTree/packages/llm/llm-deepseek/node_modules" -Target "$unpacked/dsh/node_modules"
node "$patchDir/test-card-arguments.mjs" $sourceTree
```

此外，已在隔离 web host 通过本地 SSE、真实 session/prompt、当前 schema 与工具 HTTP 回执验证。模型的建卡响应以根对象加一个多余右括号结束，正式工具仅执行一次，随后收到工具回执并完成。观察到两个对话模型请求和一个宿主自动标题请求，均打向本地 fixture。模拟取消、断流、max_tokens、非目标工具、不同 session、缺身份、其他 JSON 损坏均未产生规范化执行。原始参数保留在流增量里，诊断记录参数 SHA-256、session 与 callId。

2026-11-15 只读回放三个历史原始参数，SHA-256 前缀为 `60caa3120d8842`、`8a2b74144ba44d`、`82a32aa032697e`，仅删除多余右括号。本次故障参数 `177986489d59ab` 使用 `"connections" = [`，原样拒绝。回放仅在内存中解析，没有执行历史建卡或提交模型请求。
