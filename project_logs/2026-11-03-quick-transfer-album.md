# 快传相册入口（2026-11-03）

范围：用户反馈 Android 只能打开文件浏览器。按 ub-mode / ui-ux-pro-max 修复手机网页，不修改桌面/runtime/真实用户库或设备，不提交。

1. 阅读当前 PROJECT 快传约定、手机 HTML/真实 LAN 测试、UI-DESIGN-SPEC 与 USER-FACING-ERRORS。维持现有工业制图布局；选择按钮使用明确“相册”/“文件”，不增加无必要描述。
2. 先核验官方来源：当前 Chromium Android `SelectFileDialog.shouldUsePhotoPicker` 要求只含图片/视频 MIME、未要求 capture 且浏览器支持；`isSupportedPhotoPickerTypes` 对空 MIME 列表返回 false。现页面没有 accept，确实没有向 Android Chrome 提供媒体选择条件。
   - [Chromium Android 源码](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/android/java/src/org/chromium/ui/base/SelectFileDialog.java)（本次读取 blob `0d7dccd15f21a809f9d8ab5f46f5acb21b9cffd3`，shouldUsePhotoPicker / isSupportedPhotoPickerTypes）。
   - [WHATWG File Upload](https://html.spec.whatwg.org/multipage/input.html#file-upload-state-(type=file))：accept 是类型与界面提示；浏览器决定实际选择界面，不授权网站指定任意厂商相册 App。
   - [Android Photo picker](https://developer.android.com/training/data-storage/shared/photo-picker)：系统媒体选择器支持照片/视频；原生支持库在不可用时回退文档选择器。这个原生示例不能直接视为网站 API。
3. 最小改动：独立媒体 input 使用 `accept="image/*,video/*" multiple`，不加 capture；保留无 accept 的普通文件 input 供音频/文本等素材。两个入口共同走原有队列/顺序发送/接收确认，不加 UA 判断，服务端格式与内容校验仍为权威。浏览器/系统选择器版本会影响具体外观，不能保证任意厂商相册界面。
4. 红测实跑：真实 WLAN listener + Chrome 点击尚不存在的相册入口，filechooser 事件等待 5 秒超时。然后只改正式 upload.html：两个按钮并排、单独媒体 input，共用按 event.currentTarget 读取/重置的选择函数；无选择时保留现有队列，发送中或失连时两按钮都禁用，配对前整组隐藏。
5. 绿测实跑：同一 WLAN `192.168.1.5` 的独立 harness **18/18 通过**（5 地址、12 传输、1 浏览器入口含 **14 组行为**），page errors 0、外网请求 0。新测试从实际按钮触发 Chrome filechooser，检查相册 accept/multiple/无 capture、文件无 accept/multiple/无 capture；选择合成 PNG/MP4 后真实顺序上传成功；空选择取消保留队列、成功后再次选择相同 PNG 恢复待发送；普通入口选择 TXT/MP3 并通过真实上传。测试 fixture 允许这些扩展名，仅用于传输验证，文件内容是临时合成字节，不代替正式媒体解码校验。
6. 已查看 390px 深色 `apps/desktop/.tmp/quick-transfer-mobile/album-files-390.png` 和 320px 浅色 `mobile-320-light.png`，原位两个入口清楚，无横向溢出。原有配对、接收确认、取消、断网、回执丢失、旧码与深浅色回归全部保留。生产 HTML 冻结后交独立 agent 运行官方质量工具，父任务负责主 crate 的 include_str 编译和整体存档。

验收边界：Chrome filechooser 事件验证的是网页正确提出媒体类型和多选请求；测试注入文件不是操纵 Android 系统相册，未操作用户手机/相册/真实素材库。实际厂商相册或浏览器内嵌选择器须用户手机确认。修复未添加 capture、UA 分支或客户端格式白名单，未放宽服务端鉴权/素材校验。
