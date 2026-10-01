# 2026-10-01 上线依赖审计修复

PR #74 的首轮 CI（commit `e5684d35df94883d23c4fa23a5cdd7c0fc6578d5`）通过 lint、typecheck、全部测试、构建和浏览器 E2E，但 `npm audit --audit-level=high` 报 5 个高风险依赖节点。该轮没有修改锁文件；以下最小修复是上线验收的一部分，不能以跳过审计代替。

| 依赖 | 原版本 → 修复版本 | 当前项目可达性与选择理由 |
| --- | --- | --- |
| sharp | 0.35.3 → 0.35.4 | 生产运行时的已发布封面缩略图会解码输入；周验收也会解码图片。选择安全公告给出的首个修复补丁，保持现有 API 与 Node 门槛。直接依赖及原有全局 override 同步固定版本。 |
| undici | 7.29.0 → 7.29.1 | 仅通过开发依赖 Wrangler → Miniflare 安装；应用没有导入该 npm 包，运行时使用 Node 自带 fetch。用仅作用于 Miniflare 的 override 选择公告给出的同系列补丁；不据此声称 Node 内置 HTTP 库得到更新。 |
| brace-expansion | 5.0.9 → 5.0.12 | 仅在开发工具的 minimatch 链中使用。5.0.12 满足原来的 `^5.0.8` 范围并修复本轮全部相关公告，仅更新锁文件。 |

Wrangler 保持 4.120.0，Miniflare 保持 5.20260801.1-alpha，Node 生产版本保持 22.23.1。没有强制审计修复、跨主版本升级、改变 CI 门槛或新增业务功能。Sharp 平台二进制、libvips 1.3.3 及其必要运行时伴随包由所选补丁更新；Linux 产物仍需在生产部署前的隔离构建中实测。

官方证据：

- [Sharp 安全公告及首个修复 0.35.4](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c)、[0.35.4 发布说明](https://github.com/lovell/sharp/releases/tag/v0.35.4)。
- [Undici 7.29.1 发布说明](https://github.com/nodejs/undici/releases/tag/v7.29.1)、[TLS 校验修复公告](https://github.com/advisories/GHSA-w293-vg96-wgc3)。本轮日志中的其余 Undici 公告也逐项查询官方 GitHub Advisory API，7.x 的首个修复均为 7.29.1。
- [Brace expansion 递归耗尽修复](https://github.com/advisories/GHSA-qhr7-859c-m2p7)、[二次时间扩展修复 5.0.12](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr)。

安装与验证仅在隔离工作副本进行，原项目的依赖目录不改写。完成 `npm ci` 后必须重新运行完整测试、lint、typecheck、build、浏览器 E2E 和原审计命令，并核对同一 PR 最新确切 commit 的 CI。生产部署使用审核后的确切 commit 与锁文件 SHA-256，保留既有备份和回滚门槛。
