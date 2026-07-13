# 系统加固报告

审查与实现日期：2026-07-13  
分支：`fix/system-hardening-phase-1`  
基线：`1e7cf901c07c9e6dd9c4b1d00a75ceb1e2292de0`

本次只修改本地代码、测试、构建和运维文档。没有调用 Production DeepSeek，没有写入或清理 Production KV，没有触发 `/daily-refresh`、`/ai-cards`，没有部署或修改 Cloudflare 配置。

## 一、项目现状

- 前端：原生 HTML/CSS/JavaScript，主要交互集中在 `app.js`。
- 后端：Cloudflare Pages Functions；定时任务由独立 Cloudflare Worker 触发。
- 数据：Cloudflare KV 的单工作流 JSON；没有关系数据库、对象存储或文件上传接口。
- 第三方服务：DeepSeek 生成候选词与词卡；小红书页面只读抓取用于发布数据刷新。
- 构建：Node.js 脚本生成词库和 `dist/` 静态白名单产物；Wrangler 负责 Pages/Worker 打包与部署。
- 核心流程：Access 登录 -> 读取团队工作流 -> 浏览/收藏/标记 -> 服务端校验写入 -> 日更任务生成候选和今日快照 -> 分批生成词卡 -> 发布记录与复盘。

数据流：

```text
Browser -> Cloudflare Access -> Pages/Pages Functions -> KV
                                      |               ^
                                      +-> DeepSeek    |
                                      +-> XHS (GET)   |
Scheduled Worker -> authenticated Pages endpoints ---+
```

## 二、风险与处理结果

### 严重：已修复

1. API 缺少统一、可靠认证：改为失败关闭；管理令牌、自动任务令牌分域；Cloudflare Access JWT 校验签名、issuer、audience、expiry 和 email。
2. 自动任务与人工编辑可能互相覆盖：增加 revision、operation ID、幂等去重和自动/人工字段所有权合并；日更保存前重新读取最新工作流。
3. 部署可能上传仓库源文件和文档：构建改为 `dist/` 白名单，只包含运行所需静态文件和图片。
4. 小红书 URL 抓取存在 SSRF/重定向风险：限定 HTTPS、可信主机、端口、重定向跳数、响应类型、大小与超时。

### 较高：已修复

1. JSON 请求缺少统一大小、类型和格式校验：增加 256KB-8MB 的分接口限制，强制 `application/json`。
2. 浏览器写入仅依赖 CORS：增加 Origin 与 `Sec-Fetch-Site` 写入校验，阻止跨站请求。
3. 重复点击、网络抖动和旧响应回写：增加请求超时、取消、同操作锁、写入队列、409 冲突刷新。
4. DeepSeek 重复请求和无边界调用：认证前置、超时、有限重试、速率限制、幂等检查；内部调用传递自动任务凭证。
5. 缺少可关联日志：新增统一中间件、request ID、耗时和状态日志；错误响应不泄露异常正文或 secret。
6. 缺少操作审计：schema v2 增加最近 100 条审计记录，含 actor、时间、动作、revision 与非敏感 before/after 计数摘要。
7. 恢复过程容易误写：新增只读备份和默认 dry-run 恢复；正式恢复要求 `--apply --confirm=RESTORE` 与最新 revision。
8. 旧 Worker 直连 API 可形成第二套写入入口：默认返回 410，只有显式开启才可用；保留路径也补齐认证、校验、revision 和审计。

### 一般：已修复

1. 无统一错误响应与安全头：新增统一错误结构、CORS、安全头和全局异常兜底。
2. 无健康检查：新增 Pages 与 Worker `/healthz`。
3. 无标准质量门：补齐独立 `lint`、`typecheck`、`test`、`build` 和 PR CI。
4. 依赖未锁定：生成 lockfile，固定 ESLint、TypeScript、Wrangler 版本；移除全局 DNS 临时补丁。
5. 浏览器缺少备份恢复、未保存提醒与全局异常提示：均已补充。
6. 今日快照重复请求响应字段不完整：幂等响应补回计数、shortage 和质量审计字段。
7. 全量类型探测发现前端引用未定义的 30 天重复拦截常量：已改用现有 `TODAY_HISTORY_DEDUP_DAYS`，并启用全项目 ESLint `no-undef` 防回归。

## 三、暂未彻底消除

### 较高

1. Cloudflare KV 没有事务或 compare-and-set。revision 能阻止旧客户端覆盖，operation ID 能去重，但两个请求同时读取同一 revision 时仍可能竞态。彻底解决需要 Durable Object 串行协调，或迁移到带事务的 D1。
2. 新认证代码尚未部署，Cloudflare Access 与新增变量也尚未配置。部署前必须先配置，不能先发布代码。

### 一般

1. `app.js` 仍是约九千行的单文件，完整模块化和全量 TypeScript 会形成大范围回归风险。本阶段只抽出服务端安全、mutation 和构建模块；typecheck 先覆盖新增核心模块。
2. CSP 仍允许 inline script/style，因为现有页面使用 inline handler。移除需要先分批改造事件绑定。
3. 自动测试尚无持续运行的真实浏览器 E2E；本次完成了 Wrangler 本地 HTTP 集成检查，但没有把浏览器流程接入 CI。
4. 团队成员目前是同一权限级别，没有只读、编辑、管理员角色分层。
5. `.github/workflows/sync-favorites.yml` 是疑似废弃的 Gist 导出流程。仓库内没有调用方，但删除前仍需确认是否有外部 `repository_dispatch` 使用者。

## 四、核心修改

- 安全与数据：`shared/api-security.mjs`、`shared/workflow-mutation.mjs`、`shared/workflow-schema.mjs`、`shared/published-refresh.mjs`。
- API：`functions/_middleware.js`、`functions/healthz.js` 及全部核心 Functions。
- Worker：认证、定时调用凭证、旧 API 关闭、并发写入保护、健康检查。
- 前端：统一请求封装、超时/取消、重复操作锁、串行保存、冲突处理、异常捕获、未保存提醒、备份恢复。
- 工程：ESLint、增量 TypeScript、循环依赖检查、静态白名单构建、固定 Wrangler、GitHub Actions 质量门。
- 运维：`.env.example`、`docs/SYSTEM_HARDENING.md`、`docs/DEPLOYMENT.md`、备份/恢复脚本。

## 五、数据迁移

- 工作流 schema 从 v1 升到 v2，新增 `revision` 与 `auditLog`。
- 读取 v1 时自动补 `revision=0` 和空审计日志；第一次认证写入时保存为 v2。
- 不需要单独执行 Production KV 迁移，也不得清 KV。
- 回滚旧代码可能在下一次旧版写入时丢掉 v2 元数据，因此回滚前必须备份并暂停写入。

## 六、验证结果

- `npm run lint`：通过；循环依赖检查通过（30 个模块）。
- `npm run typecheck`：通过。
- `npm test`：通过；45 个既有 workflow 回归用例 + 19 个新增加固用例。
- `npm run build`：通过；生成 264 词与 `dist/` 白名单产物。
- `npm audit --audit-level=high`：通过，0 vulnerabilities。
- Wrangler Pages Functions build：通过。
- Wrangler Worker `deploy --dry-run`：通过，无构建警告，未上传。
- 本地 Pages：页面 200、`/healthz` 200、本地开发认证 200、伪装生产 Host 未认证 401、响应头/响应体 request ID 一致。

## 七、部署与回滚

部署前：配置 Access、`TEAM_ACCESS_EMAILS`、`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`ADMIN_API_TOKEN`、两端一致的 `AUTO_REFRESH_SECRET`、`ALLOWED_ORIGINS` 和 `SITE_URL`；先导出并检查备份。

部署顺序：质量门 -> 备份 -> Pages -> 只读健康检查 -> Worker -> 只读健康检查 -> 观察日志。任何生成与数据写入验证必须单独获得 Production 批准。

回滚顺序：回退 Pages -> 必要时回退 Worker -> 不清 KV -> 对比 revision/计数与备份 -> 仅在预览正确且 revision 未变化时执行 guarded restore。

## 八、后续优先五项

1. 用 Durable Object 包住工作流写入，彻底关闭 KV 同 revision 竞态。
2. 先配置并验证 Cloudflare Access/变量，再做一次受控部署；部署前后均只读核对计数。
3. 按“请求层、状态层、领域规则、视图组件”逐步拆分 `app.js`，同步扩大 typecheck。
4. 增加 Playwright E2E：登录后读取、收藏、状态修改、冲突、网络失败、备份 dry-run；Production 生成接口继续排除。
5. 确认 Gist 同步和 GitHub Pages 是否仍有外部使用者；确认无使用后删除废弃工作流与部署路径。
