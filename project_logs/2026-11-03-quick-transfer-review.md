# 快传传输层独立审查

日期：2026-11-03（北京时间）。审查仅覆盖新增 `quick_transfer/transport.rs` 与 `vendor/localsend-core` 接收适配；正式界面未修改。实现者负责修复，审查者只新增临时隔离复现和本记录。

## 发现与修复闭环

1. **跨源取消与 Host 未限制。** 初始隔离 HTTP 复现：`Host: rebinding.example:53317` 的根页面请求返回 200；相同来源 IP、不带配对 PIN、带 `Origin: http://foreign.example` 的 `/api/localsend/v2/cancel` 返回 200，并把真实等待中的 prepare 请求取消为 403。此证据证明跨源请求可影响同 IP 会话，以及任意 Host 会被接受；未把它夸大为已完成 DNS rebinding 浏览器攻击或配对令牌泄漏。
2. **已接纳但从未开始上传的会话没有过期。** 初始 transport 快照在 prepare 200 后等待 63 秒，新 prepare 仍为 409，且没有 Failed 清理事件。手机关页即可留住唯一上传槽位。实现者加入无活动且无 writer 时的 60 秒清理，取消上游会话并释放待开始文件。
3. **writer 超时与 HTTP body 生命周期分离。** 静态发现 writer 等待分块超时后，vendor 仍可能等待 `body.frame()`，无法结束协议会话。实现者在 body 帧读取加入 60 秒超时。第一次隔离实验编译时该修复已进入 vendor，不能记为旧版本的失败复现；随后以保持旧 socket 开启的测试核验释放成功。
4. 实现者同时收紧具体 IPv4 接收模式的路由：仅网页／翻译及上传、取消 API；注册、发现、v3、下载等未使用入口拒绝。Host 对实际 IP:端口严格匹配，带 Origin 的请求必须同源，取消额外校验 PIN；响应加入 no-store、no-referrer、nosniff、frame DENY 和限定同源资源的 CSP。无 Origin 请求仍须通过对应配对／文件令牌检查。

## 独立复验

临时 harness：`.tmp/quick-transfer-review/`；仅监听 `127.0.0.1`，文件写入 `tempfile` 独立目录，不读写用户库。测试使用原始 **60 秒** 超时，没有通过缩短阈值替代时间行为。

- 外部 Host 403；跨源无 PIN 取消 403；真实 prepare 仍正常完成为 200。
- 无 PIN 的取消请求 401；v3 注册 404；根页面 no-store／no-referrer 均存在。
- prepare 之后不发送文件，63 秒后出现 Failed，下一 prepare 200。
- 上传声明 4 字节，只发送 1 字节并保持 TCP socket 开启；writer 超时后出现 Failed，下一 prepare 200，证明不是依靠客户端断开才释放槽位。

复验结果：**3 passed / 0 failed，63.02 秒**。被审查 transport 初始快照 SHA-256：`7472c0d33640422d9d714b55146f70ff34b9248a59f09bb915d2c8103a1b638c`；通过复验的 transport 快照：`960678af291207a80bbd49af8d55c168b0c67c2959ff989a21c24f605afb5623`。后一快照包含交付确认，但早于实现者随后加入的逐会话取消控制；那部分由实现者专项回归覆盖，不把本次三项结果扩展为最新文件的全功能验收。

初次沙箱执行被 Windows socket 权限 10013 阻断，不计功能失败或通过。已在正常权限下重跑；只按本任务测试 exe 的完整路径停止该次受限运行遗留进程。一次链接失败由该测试 exe 占用导致，清理后通过；没有停止其他开发／用户进程。

## 其他检查与边界

静态核对配对令牌长度／字符限制、文件令牌与发送 IP 绑定、JSON 256 KiB 限制、文件数量／累计大小上限、受控暂存路径、流式写入长度／可选摘要校验。未发现这些检查被当前公开接收入口直接绕过的证据。禁止路径字符与暂存路径控制不等于完成所有平台最终文件名验收；最终落盘、原件保留及数据库登记由入库专项负责。

HTTP 局域网模式仍不加密。本次不是真实手机 Safari／Android、企业 Wi-Fi、防火墙、Windows/macOS 安装包或长期压测验收。无公网服务、生产数据或真实素材参与；临时测试和截图不纳入代码提交。

## Runtime 与入库交界复核

追加只读检查 `quick_transfer/mod.rs`、`commands/quick_transfer.rs` 与 `core/quick_transfer.rs` 的状态契约。`active` mutex 串行 start／stop／retry；索引和恢复均先获得文件夹 GATE，再进入 store 锁，prepare／received 没有在持有 store 时等待 GATE；未发现反向锁序或重复 listener 的具体路径。关闭会等待接收任务与事件处理完成，不能把其视为强制取消正在执行的磁盘索引。

发现一条延迟失败事件竞态并通知根实现者：Received 正在后台校验／写 Ready 时关闭服务，transport 的交付确认等待可能先转 Failed；事件 worker 随后仍完成入库，再处理排队的 Failed。旧 `Context.failed` 即使 `store.cancel` 因 Ready／Saved／Indexed 拒绝删除，也会无条件把视图改为 Failed，造成已入库文件误标失败或完整收件不可重试。

根已修复：`Context.failed` 在 store 锁内检查持久记录，Ready／Saved／Indexed 直接返回，不取消文件或降级视图；只有 Receiving／无持久完成事实的任务沿半成品清理和失败展示。审查者重新读取方法与 `late_cancellation_keeps_durable_library_success`：该测试用真实临时收件目录、有效 PNG、资料库和数据库完成 prepare→received→index，再注入延迟 Failed，断言 Complete、空错误、原 asset_id 和数据库素材仍在。根执行记录为先观察 Failed／Complete 不符的红测，再于 `tests-final.exe` **全 23 项通过**。本轮只静态复核修复与回归语义，没有再次编译，也没有将该顺序故障注入测试称为真实手机停传时序验收。

曾对旧版逐块进度通知提出性能疑虑；重新读取实现者最新 `copy_chunks` 后确认 **150ms 节流、最终字节即时更新** 已存在，撤回“当前逐块通知”的判断。commands 层只在完成数量变化时广播素材库刷新。本轮未做真实长视频 CPU／IPC 压测，不以代码节流存在代替性能验收。

再次检查独立示意入口与已有 capture 报告：无需更改页面。并排审查建议 `preview.html?view=both&state=sending`，手机结果建议 `preview.html?view=mobile&theme=light&state=complete`，中断建议 `preview.html?view=mobile&state=interrupted`；顶部仍可切换状态、视图及深浅色。既有 capture 已覆盖上述状态及深浅截图；它们仍是显式示意，不是真实接收网页。正式 UI 继续等待确认。
