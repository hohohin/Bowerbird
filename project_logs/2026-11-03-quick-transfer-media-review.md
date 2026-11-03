# 2026-11-03 快传相册入口与接收缩略图独立复核

- 范围：用户反馈安卓相册选取和“本次接收”真实缩略图。本代理先只读审核素材／预览契约，给桌面负责代理与根代理建议；不先改生产后端，不操作真实用户库。已读 PROJECT 当前快传与按需预览约定、QUICK-TRANSFER、FOLDER-MODE 相关段。
- 快传 `core/quick_transfer.rs::register` 调用 `index_connected_file`，它是轻量登记。`core/connected_media.rs` 新建普通图片、HEIC、视频素材时 `thumb_path` 通常为 null；HEIC／视频甚至延迟尺寸探测。已有专项测试明确断言未请求时无缩略图／预览目录，所以不能把 `Complete` 当成缩略图已存在。
- 已建议复用 `api.getAssetsByIds`（`get_assets_by_ids`，精确按 ID 返回，忽略重复和缺失 ID），只在完成的 assetId 集合变化时补取未请求资产。避免以每 150ms 更新的整个 transfers 数组触发查询。现有 api 未发现 `assetUrl` 方法；文件界面实际使用 `convertFileSrc`。
- 真实缩略图用已有 `externalFiles.preview(store_path)` 和 `createFilePreviewQueue`。前端队列默认四并发，可取消未开始工作；后端 IPC 也有四并发 gate、缓存与内容指纹核验，生成完成会授予 asset scope 并合并500ms更新通知。返回本地 JPEG 路径可直接显示，不必再读资产来等待 thumb_path，不新增 LAN 文件／数据库读取接口，不扩充快传 Snapshot。
- 预览契约：普通图片按需生成480px JPEG；HEIC先生成可丢弃兼容PNG再缩略图，登记原路径与原HEIC字节不变；视频用系统缓存或既有视频封面生成器，不挂载播放器。音频与文本不走图片预览，保留类型图标。预览失败不改变“已入库”事实，只回退图标。
- 恢复契约：Ready／Saved重开恢复后同样获得assetId，复用同一预览路径；已Indexed的旧历史不会被重新加入“本次接收”。已建议会话／卸载迟到回包防护、按assetId与素材版本缓存、缺失资产占位；把预览加载留在弹层Queue内，收起时释放展示订阅，常驻接收owner不继续为隐藏列表解码。
- 此次未重跑无关Rust全组。正式组件、手机页面与新增纯辅助测试由实现代理按红绿执行；改动冻结后本代理再做最终源码复核与官方 crapper／dryer／mutator 扫描，并准确区分扫描、实际执行变异与覆盖率。
- 手机源码独立复核：相册使用单独 `accept="image/*,video/*" multiple` 文件输入，不加 capture；普通文件入口继续无 accept。两个选择入口共用变更处理与发送队列、各自清空 value 支持同文件重选；未配对隐藏、发送中与失连禁用两按钮，不改变接收权限。实际厂商相册界面仍由系统／浏览器决定，不把 Chromium filechooser 注入当成安卓实机验收。手机负责代理报告最终真实 WLAN harness 18 / 18 全绿、14 个浏览器行为组涵盖相册／文件入口、取消／重选以及 PNG／MP4／TXT／MP3 上传；最终 HTML SHA256：`30a91a86cc441cc4aa4347ca2b5adae0976a8036a93a109bca5c22c459eead98`。
- 桌面冻结后独立复核：`useQuickTransferAssets` 以排序后的完成assetId集合作为依赖，新增ID才批量读取，按ID匹配反序返回；移除本次队列之外的请求缓存。`resolvePreview` 分离图片／视频输入与音频／文本排除；行复用 `useMediaVisibility`，只有可见或附近行请求既有四并发预览队列，关闭取消未开始工作。结果按素材／路径／缩略图／mtime／大小组成的版本身份显示，迟到结果不串图；失败回退图标，保留已入库状态。未发现新增阻断，不需要改Rust收件链或HTTP接口。
- 最终官方工具实跑：三份脚本单元 crapper `--no-coverage`、dryer `--threshold 0.8`、mutator `--scan --no-coverage` 均exit0。生命周期hook初扫CC15，按输入解析职责收敛后CC10；metadata hook6、resolvePreview4、Queue相关最大6、手机最大8。dryer无重复；mutator扫描152候选，不能算作执行。无覆盖率，Cov%／CRAP为N/A，不宣称CRAP达标。证据 `.tmp/quick-transfer-media-quality/REPORT.md`、`final/`；四份正式文件（含CSS哈希）最终0 mismatch。
- 工具范围纠正：dryer只分析受支持后缀，单独对提取的 `.js` 返回 `No source files to analyze`。本轮将唯一内联JavaScript原文不变放进 `.ts` 隔离副本重跑，确认手机脚本实际纳入且无重复；此前混合组的dryer“无重复”不能据此推断旧 `.js` 已被分析。
- 实际单点变异：使用官方mutator候选发现／执行器，选中删除第21行请求缓存清理条件的 `!`。在隔离Vite load覆盖中执行现有整份缩略图真实Chrome测试，断言不改、正式代码不写；基线全部绿，变异因“完成素材应一批读取”计数2≠1断言失败而killed，没有超时、语法或基础设施失败。执行后副本恢复、生产SHA256保持 `2953b112c1bc73adc049dd780187c1e884ce8bc4ce0b461e3ec28f11a11b22b5`。证据 `mutation/result.json` 与两份run日志；只声称执行并杀死这一候选，不声称152候选或全项目变异通过。
- 最终 `git diff --check` 对本轮生产范围通过。本代理未重复无关Rust广测、未提交；根代理另行负责正式App像素、原生专项、完整TypeScript与构建／存档。
