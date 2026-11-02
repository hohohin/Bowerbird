# 2026-11-03 Seedance 音频参考接入

## 范围与依据

用户要求先调研 Seedance 2.5 音频输入，再推进接入。延续 ub-mode、UI/UX 技能与项目现行规范：复用现有素材引用、自动模式、单行底栏；本轮不新增音频面板、生成模式或声音开关。现行产品决策记录在 PROJECT.md。

核验一手来源：

- [方舟创建任务](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh)：`audio_url`／`reference_audio`；MP3、WAV，2.5 纯音频与混合参考，数量／时长／大小限制；输入音频与 `generate_audio` 分开。
- [Seedance 2.5 模型](https://docs.volcengine.com/docs/ark/seedance-2-5?lang=zh)：国内模型 ID 与总计 50 个输入素材。
- [官方计费](https://docs.volcengine.com/docs/ark/model-pricing?lang=zh&redirect=1)：输入视频与输出视频 token 维度；音频不当作输入视频，没有新增 Bcoin 定价。
- 本机 `C:\Users\Hins\bin\dreamina.exe version`、`multimodal2video -h`：版本 `a857341-dirty`，支持重复 `--audio` 参数；2.5 可纯音频，2.0 音频须搭配图／视频。命令没有生成或上传；版本命令曾报告日志目录写入受限，帮助正文仍正常返回。网页 CLI 入口未取得正文，不用网页壳替代契约证据。

2.5：最多 30 图／10 视频／10 音频、总计 50；音频每段 2–30 秒、合计不超过 30 秒，每段上限按 15 MiB 实装。2.0 系列：9／3／3、总计 12，音频每段及合计 2–15 秒，禁止纯音频。素材库仍可播放其他已支持格式，但 Seedance 明确要求先转换，不自动舍弃或转码。

## 行动与原因

1. 阅读 PROJECT、开发入口、Seedance／Cloud 视频、收费架构、错误提示、音频库和 UI 文档；核验官方文档与本机 CLI，区分本机 H3、即梦与 Cloud 范围。
2. 前端输入校验与 Cloud body 先补音频测试，确认旧代码拒绝音频后接入。图片生成保持拒绝；自动模式沿用上一轮的实际引用判断，显式首尾帧不覆盖。
3. 编辑器沿既有 chip 序列化保存音频身份／原件路径，以音符和文件名显示；不新增工具栏行。素材库及真实集合将项目创作中的音频激活事件交给编辑器。补查发现 AudioFileMediaCard 原先只调用详情入口，改为双击／Enter 优先调用 onActivate；普通浏览仍通过原 onOpen 打开详情，波形控件不变。
4. 原生参考解析为视频单独保留音频原件，图片继续走既有兼容转换。即梦按原顺序生成 --audio 参数；提交前检查文件头、大小并用 Symphonia 解码每段和合计时长。原生测试初次被 Windows Common Controls 清单问题阻塞；后来修正合成 WAV 的采样计数，实际验证 1／2／30／31 秒边界。
5. Cloud 加入可选音频 manifest，服务端生成私有路径和分类上传槽位，桌面原件 PUT 经官网网关。无音频省略新增字段以保留历史哈希。补只读能力查询，防止新桌面与旧 Edge 混用时音频被忽略。
6. Worker 在一次付费提交前下载并探测实际音频，校验真实格式、字节和时长，保持租约、同任务恢复与原计费。MP3 gapless 解码与容器时长可能略有差异，补失败用例后移除毫秒相等要求，改以服务端实际文件时长为准；超限仍在提交前拒绝。
7. 增加 0079 兼容迁移、官网固定路径／MIME／大小规则，补 Edge 重放、归属及租约校验和内存数据库测试。没有执行生产迁移、部署、上传用户素材或调用模型。
8. 正式组件隔离测试补素材库音频选择。初版动态加载 React 使用不同缓存实例、未正确挂载，改为已有音频夹具的 reference 场景，未改产品代码绕过测试。完整音频库播放／选择／改名删除释放／虚拟列表回归通过。
9. 复核最终 diff，更新 PROJECT 和三个专项文档；只提交本轮文件及 PROJECT 的两处音频约定，保留同时工作的其他聊天改动。

## 验证结果

- 桌面 `video-generation.test.mjs`、`video-reference-editor.test.mjs`：36/36；音频格式、模式、数量／时长、chip 保存恢复。
- `video-auto-mode-ui.test.mjs`：真实创作框／详情编辑提交、音频 chip／原件路径、两类素材库实际激活、FLAC 拒绝、900px 深浅主题底栏单行通过。
- `canvas-workflow-auto-video.test.mjs`：21 项通过，包括自有订阅／Cloud 音频、多参考、显式首尾帧拒绝。
- `audio-library-ui.test.mjs`：原有播放、波形定位、选择、详情／文件操作和虚拟列表回归通过；全部用合成音频与封闭 IPC。
- 桌面与 Worker 完整 TypeScript 通过。沙箱内依赖 realpath 曾导致假错误，获准在同目录运行检查后通过；Deno 沙箱拒绝访问后也使用获准的隔离运行。
- Worker `ark-video.test.ts`、`video.test.ts`：17/17；包含音频实际探测先于唯一 POST、MP3 时长偏差、失败／恢复及计费边界。
- `video-audio-probe.test.ts`：1/1；FFmpeg 制造真实 WAV／MP3，ffprobe 通过，伪装 FLAC／损坏内容拒绝。FFmpeg 路径 `D:\Tools\ffmpeg-2025-09-04-git-2611874a50-essentials_build\bin`，仅用于测试输入／服务端探测，桌面解码无此运行依赖。
- Edge 两个入口 Deno check；generate-proxy `audio_test.ts` 和 `index_test.ts`：6/6，包含能力查询不扣款、私有路径、上传完成入队、重放／409、音频不算参考视频、租约与跨任务访问拒绝。
- 官网 `cloud-proxy.test.mjs`：17/17，音频 MIME／大小／精确字节、原视频和结果下载回归。
- `video-generation-db.test.mjs`：PGlite 内存数据库通过，0079 允许 50 项／拒绝 51 项、音频 MIME，沿用原结算与恢复检查。
- Rust `cargo test --locked --offline --lib --no-run` 完整测试编译通过（既有 6 条 warning）。测试 EXE 直接启动遇到 `STATUS_ENTRYPOINT_NOT_FOUND`：当前测试目标未嵌入 Common Controls v6 manifest，缺 TaskDialogIndirect。仅复制到 `.tmp/audio-integration-native/audio-tests.exe` 并用 Windows SDK mt.exe 嵌入清单后运行：`codex::jimeng_video::tests` 9/9，`core::audio::tests::audio_originals_cannot_be_sent_as_image_model_references` 1/1。未改正式 EXE／构建脚本，也未声称全量 Rust 运行通过。
- ub-mode 所列 crapper／dryer／mutator 当前不可用，未伪称执行；人工检查与实际测试不替代这些工具报告。

## 交付与上线边界

源码与隔离验证完成，尚未部署、打包或做模型真实生成，未产生上游费用。Mac 原生、实际账号权限／CLI 版本、音画同步质量、生产上传与扣费待真实验收。

部署顺序：0079 → Worker（共享 contract 同步）、generation-worker、官网网关 → generate-proxy 能力响应最后 → 桌面。具体恢复与兼容说明见 [Cloud 视频协议](../dev-doc/VIDEO-API-INTEGRATION.md#2026-11-03-音频参考源码未部署)。不能提前单独部署能力响应。

本轮只做本地提交。此前远端推送被自动审批拒绝（缺少明确远端目标授权）；没有重复尝试或规避此限制。
