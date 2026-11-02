# 文本素材与内置编辑器

2026-11-02，源码待发布。产品范围与决定以 [PROJECT.md](../PROJECT.md) 为准。

## 接入范围

- `.md`、`.markdown`、`.txt` 复用「建立连接」及文件夹扫描，登记原路径，不复制已有文件。
- 现有素材库类型控件增加文本，沿用全部、标签、集合、搜索、分页、分栏和轻量卡片。卡片只读索引元数据，打开详情才加载 Plate 和正文。
- 编辑器在原 `AssetDetail` 媒体舞台内，原顶部栏、侧栏和右侧资料区不改布局。文本不显示图像反推／再创作，也不能作为画板图片或模型图片参考。
- Markdown 有正文／源码、标题、粗体、斜体、简单列表、引用、撤销／重做；TXT 按字面编辑。显式保存或 Ctrl/⌘+S 写回原文件。
- 文档内可插入已有图片、音频、视频引用；移除文档中的块只修改文档。对话、Agent、生图／视频转发不在本轮。

## 原件与草稿

入口：`core/text_documents.rs`、`commands/text_documents.rs`、`TextDocumentEditor.tsx`。

`read_text_document(assetId)` 和 `save_text_document(assetId, expectedVersion, text)` 返回 `{ assetId, path, text, version, format }`。命令只接受登记的素材身份，读取 `assets.store_path`，不提供任意路径写入。磁盘工作在线程池执行。

- 暂支持最多 2 MiB 的 UTF-8（含 BOM），其他编码、二进制、只读、失联或超大文件清晰报错。
- 版本为文件内容 SHA-256。保存先核对打开版本，同一路径的应用内保存串行；准备替换文件后再次核对版本及登记路径，发现外部变化拒绝覆盖。
- 在原目录写临时文件并同步后原子替换，再刷新原素材索引、广播更新；标签和身份保持。索引刷新失败明确区分「原件已保存，索引待刷新」。没有与任意外部进程协作的文件事务，不宣称能消除校验和替换之间的所有系统级竞争。
- 保留 UTF-8 BOM、常规 LF/CRLF、系统基本权限；无变化保存不改混合换行。编辑后混合换行按原件是否含 CRLF 统一。未验证扩展 ACL、扩展属性或网络文件系统替换语义。
- 草稿以素材 ID 和原路径分开保存在当前应用会话的内存及 sessionStorage；内存是存储失败后的兜底，并显示先保存再退出提示。应用退出尝试提示未保存，不承诺进程崩溃／彻底退出后恢复。
- 保存回包合并共享最新草稿，保存期间继续输入、离开再打开和旧回包乱序均不会覆盖新输入。重新读取原件丢弃未保存草稿前确认；读取期间已继续编辑则忽略旧读取回包。

## Markdown 与媒体

使用 MIT 的 Plate 53.5.2 与所选基础、列表、Markdown、媒体插件，不使用 Plate Plus 模板。锁定版本见 `apps/desktop/package.json` 与根锁文件；许可文本随 `apps/desktop/public/licenses/text-editor.txt` 进入前端构建产物。

媒体保存为受控引用，例如：

```html
<img data-bowerbird-asset="ID" data-caption="URL编码说明" data-source="URL编码原路径" />
```

`audio`、`video` 使用同一属性协议。原路径是溯源信息；当前仅解析已经登记的 ID，不依据文档内容自动读取或登记任意本机路径。文件导入通过现有原位连接 API，图片按需显示、音频复用共享波形播放器、视频 `preload="none"`。当前同库重新打开可恢复引用，不宣称跨设备 ID 恢复已完成。

不执行 HTML/MDX 或自动请求外部媒体。外部图片、链接、表格、代码、任务列表、frontmatter、复杂列表等本轮未支持的语法保留为字面源码块，亦可在源码模式直接修改。禁止剪贴板媒体自动转成无来源附件；普通图片 URL 仍是文字。正文编辑可能规范化 Markdown 的空行、强调符号与软换行空白，不宣称字节级无损；仅打开或切模式不会自动写原件。

## 验证入口

全部为合成 IPC 或临时文件／SQLite，不操作用户库、不调用生成模型。

- Rust `core::text_documents::tests`：10 项，涵盖真实原位登记、目录／查询类型过滤、不走图片解码、UTF-8 BOM/CRLF、混合换行无操作、外改冲突、只读、大小上限、并发保存与标签／身份保留。
- 原生回归：external_files 24、folder_connections 38、ingest 26、audio 10、catalog_browser 7 通过；另有 5 项既有环境忽略，未将忽略视为通过。
- `scripts/text-document-codec.test.mjs`、`text-document-drafts.test.mjs`、`text-media.test.mjs`、`user-error.test.mjs`：格式保留、软／硬换行、媒体引用、异步保存草稿、类型分类和中文编码指引。
- `scripts/text-library-ui.test.mjs`：真实 `AssetDetail`／Plate 编辑、源码、保存／冲突、退出重开期间保存、三类媒体引用、纯文本、深浅与 900/1440 宽度、无远程请求／模型调用。
- `scripts/text-catalog-ui.test.mjs`：真实素材列表的类型查询、轻量文本卡片、详情入口、分栏状态和文本操作边界。
- 完整 TypeScript、独立 Vite 生产构建通过；Plate 输出独立懒加载 chunk。开发辅助产物位于 `apps/desktop/.tmp/text-library*`，不用于发布。

未构建安装包；Windows 原生完整编辑手势、Mac 原生、网络目录、大文档长期性能和跨设备资料恢复待各自环境验收。
