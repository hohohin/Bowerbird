# 2026-11-11 HTML Renderer 0.1.2 部署与回退

北京时间 12:17:21 开始切换，12:17:42 确认现役容器健康，12:18:26 再次读回版本、隔离配置和空队列。本轮交付工程审查 BB-08 的排队后容量释放修复，沿用既有 test-only 范围。

## 版本与部署范围

| 项目 | 上线前 | 现役 |
|---|---|---|
| Renderer | 0.1.1 | 0.1.2 |
| 渲染指纹 | `bwr1-c0ee5722787c038aa560e4a5cbb54df2` | `bwr1-f75e299e40fc851b842b81f7336ab083` |
| Docker 镜像 ID | `sha256:a49ad66251b534af8a9aa22ec2282b76a9dc5d05ba1bcd2c1a8b071c1e65e479` | `sha256:47d44c619f28f749502d43f16c8d443152e0785331b5421c37b3e4cf74f4e110` |
| Chromium / Playwright | 151.0.7922.34 / 1.62.1 | 151.0.7922.34 / 1.62.1 |

上线前，VPS 源目录、运行镜像和本地 Git 基线的三个输入逐一核对。候选直接继承现役镜像，使用断网 Docker 构建。正式切换只更新 Renderer 的三个源码文件、镜像标签和 Compose 服务实例。现役镜像内读回 SHA-256 如下。

| 输入 | SHA-256 |
|---|---|
| `package.json` | `db68c4b3ef09547ba60efe69a2de25d66d8e9309ec6d7e9014e2e3f3f18d16bd` |
| `src/server.ts` | `e48efede1caaeb3178460a2c06426249da2f6d1a13435e88929ebf4ac7906462` |
| `src/fingerprint.ts` | `c50f9c51bcf1850ab5878eb1f5423b1a52f70344e5cabdccfa13819fb9d82b7e` |

## 候选与现役验收

- 候选容器使用单独 DNS 名；旧实例仍指向 0.1.1。候选通过隔离自检、真实整页及切片检查、并发渲染、队列清零和后续任务检查后移除。切换前连续两次确认旧实例空闲，再从 Worker 原路复核旧指纹。
- 现役复跑合成中文长页，输出 720 × 3840 的整页和 4 张切片，合计 817,672 字节，切片逐像素拼接与整页相同。
- 从原 Worker 容器经既有 `http://html-renderer:3917` 和内部认证提交两次并发渲染。健康端点在执行期间观测到 `busy=true, queued=1`，两个请求均成功，再连续提交两次均成功。四个 PNG 均核对输出声明和实际像素文件字节的 SHA-256，为 `5af04c47a91b3f459fad23258fefc94248eea06aad66c932d9a57421a45e2de1`。现役共 5 次成功，0 次失败，随后两次读回均为 `busy=false, queued=0`。
- 现役容器 ID 为 `b39c15c8905d08332fe59ce90f62792ae778c40ba956caedc69638e6319812e2`。复核非 root、只读根、内部单网络、无宿主端口、无宿主绑定挂载、drop ALL、no-new-privileges、seccomp 和 Chromium sandbox。资源限制为 1 CPU、1536 MiB 和 256 PID。Worker 中只运行合成 HTTP 探针。本轮验证覆盖渲染服务及 Worker 内网调用，自然 Agent 任务与桌面入库另行验收。

## 回退

VPS 备份目录为 `/opt/bowerbird/renderer-releases/20261111-audit`。原镜像已标记 `bowerbird/html-renderer:rollback-20261111-audit`。三个原文件保存在 `before.tar`，SHA-256 为 `8bf87c8873b10953e15faf10ab4c9c5b197bed8293ed3b2fcc49639a4f733efb`。

需要回退时，先读现役 `/healthz` 确认队列空闲并核对本批镜像，然后在 VPS 运行 `sudo bash /opt/bowerbird/renderer-releases/20261111-audit/rollback.sh`。脚本核对镜像 ID、还原三个文件、核对原始 SHA-256、恢复原镜像标签并仅重建 Renderer，最后检查 0.1.1 和原指纹。脚本 SHA-256 为 `644ce39e3ee46e25f7e8ff5a903ba08d37ffc0eb73eba639c377af987baa764e`。本次切换成功，回退未触发。

本机逐步日志位于 `.tmp/audit-renderer-deploy-20261111/` 中的 `inventory.log`、`prepare.log`、`activate.log` 和 `postcheck.log`。
