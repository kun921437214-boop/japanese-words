# 微信小程序接入与交互验收

小程序是新增手机入口，电脑静态网站、原有 API、localStorage 键和团队工作流格式保持兼容。后端部署目标沿用当前腾讯 Production 的 Node 运行时 / FileKV；Cloudflare 回滚栈不提供微信网关，也不接收本次数据写入。

## 首版范围

已实现原生今日推荐、稍后看 / 恢复、团队选题池搜索与状态筛选、完整词卡阅读、标题 / 词卡复制、已有参考图查看 / 保存、收藏 / 移除 / 待发布、成员登录及同步状态页。候选池仍属于系统侧供给；批量管理和发布记录整理继续由电脑端承担。本版没有小程序内 AI 生成、完整工作流保存、导入、后台管理或自动发布入口。

## 登录与成员开通

1. 小程序中 `wx.login` 取得一次性 code，POST 到 `/miniapp/login`。
2. 服务器通过微信 `https://api.weixin.qq.com/sns/jscode2session` 核验 code，AppSecret 只保留在受保护的服务器环境。
3. 使用 `SHA256(AppID + ':' + OpenID)` 前 24 位作为成员编号。未经批准只返回这个编号，不返回令牌或团队数据。管理员确认对应人员后，将编号加入服务器 `WECHAT_MEMBER_IDS`。
4. 已批准成员取得随机 256 位会话令牌，有效期 7 天。服务端只存令牌摘要、成员编号、到期时间，不存 `session_key` 或原始 OpenID。
5. 每次 API 请求都核查当前允许列表；从列表移除并重启配置后，现有会话也失效。退出删除本次会话，多设备会话相互独立。
6. 手机端在即将过期或 401 时自动重新登录一次；成员变更时拒绝重放旧账号的请求，不进入无限跳转 / 刷新循环。

会话放在 `/var/lib/japanese-words/miniapp-sessions`，不混入 workflow-kv，不需要随业务备份恢复。恢复服务器后允许用户重新登录。文件使用 FileKV 私有目录 / 文件权限，过期验证由应用和 FileKV 双重检查。少量过期会话文件不会自动全盘清扫，可在维护时清理过期会话目录内容；不要将其加入静态构建。

## 接口边界

| 接口 | 用途 |
| --- | --- |
| POST `/miniapp/login` | 交换微信登录凭证，检查团队批准 |
| GET `/miniapp/me` | 查看会话身份 / 到期时间 |
| POST `/miniapp/logout` | 撤销当前会话 |
| GET `/miniapp/workflow?scope=today或favorites或published` | 复用精简列表投影 |
| GET `/miniapp/card?word=...` | 按需读取完整正式词卡 |
| GET `/miniapp/confirmation?word=...` | 精简团队收藏状态回读 |
| POST `/miniapp/favorite` | 仅 add / remove / status(none,pending)，必须带 operationId |
| GET `/miniapp/image?word=...` | 读取该正式词卡绑定的第一方参考图，Bearer 放请求头 |

所有已登录请求都需要个人会话 Bearer；`ALLOW_PUBLIC_APP=true`、网页 Cookie 和管理员令牌都不能绕过此入口的成员认证。没有任意 URL 代理和 `code` 切换团队空间。收藏命令在原协调器串行执行，并在原子操作内部保护已发布状态，审计 actor 为成员编号。

## 部署前需要完成

- 核对真实小程序账号、AppID 和主体；在微信后台配置实际需要的服务类别、隐私说明、合法 request / downloadFile HTTPS 域名。以管理后台当前要求为准，不能用测试号或关闭域名校验代替正式配置。
- 在受保护服务器环境配置 `server/miniapp.env.example` 列出的变量；`ENABLE_WECHAT_MINIAPP` 默认 false。AppID 可公开，AppSecret 不进入客户端、Git 或聊天。
- 当前网关只新增一个 HTTPS `/miniapp/` 路由。`server/nginx/miniapp-location.conf.example` 是待审阅片段，不会被部署脚本自动应用。保留现有网页认证策略；若当前站点另有 Basic / Access 认证，需要现场确认它如何覆盖这条路由，再审阅对应的最小身份认证配置，不能全站关闭原认证。
- 按 `docs/DEPLOYMENT.md` 的既有流程，在批准部署后执行最新远端比较、测试、服务器备份、Nginx 配置校验、受控重启及只读健康核验。北京共享机上的 Nginx、飞书机器人、Xray 受保护；本次开发未连接或修改服务器。
- 网关上线且微信配置完成后，管理员先开通自己的成员编号；再用本人手机进行下面的验收。未经批准成员只能看到开通提示。
- 使用工具预览 / 体验版并完成真机验收后，才进入微信审核发布。源码或 GitHub PR 不代表已经上传、审核或上线。

## 验收场景

| 场景 | 预期 |
| --- | --- |
| 首次进入 | 未勾选说明不能登录；拒绝登录可体验明确标注的示例 |
| 首次未批准 | 无团队数据，显示可复制的成员编号 |
| 日常重新打开 | 自动恢复会话，保持上次本机缓存，后台刷新 |
| 会话过期 / 401 | 单次自动恢复；失败给出可重试错误 |
| 换微信成员 | 不读取或提交旧成员的缓存 / 操作 |
| 收藏多次连点 | 同一个词只有一个待同步操作 |
| 请求已保存但响应丢失 | 重连先回读服务器；不重复提交 |
| 杀掉小程序后重开 | 同一成员恢复原 operationId 和待同步状态 |
| 收藏 / 待发布并发 | 原子修改最新状态，不丢其他成员收藏及词卡 |
| 词在同步中被标记已发布 | 不将已发布降回待发布；允许读取团队状态以解决冲突 |
| 当天推荐未更新 | 展示实际日期与过期提示 |
| 未就绪词卡 | 无正式模板、无复制按钮能力，仅基础信息和刷新 |
| 参考图加载失败 / 相册拒绝 | 不展示成功；允许重试或继续浏览 |
| 手机小屏 / 大字 | 主按钮可点，详情底部不遮内容，日语长词可换行 |
| 网页原有流程 | 今日、选题池、发布记录、系统候选库和词卡 JSON 兼容 |

## 维护注意

小程序业务数据保存在 `kotoba_miniapp_cache_v1:<memberId>`，不读取网页旧 localStorage，也不会静默合并个人历史数据。完整词卡缓存保留最近 30 条；离线操作队列上限 50 条。服务器回读前一直显示待同步。清除本机意图需要成功读取团队状态，避免误把超时当成从未保存。

参考图通过认证下载为临时文件，再交给微信预览和相册 API。图片缺失时不从其他 URL 抓取替代素材。当前版本只读取腾讯 `REFERENCE_IMAGES_KV` 中的第一方 Codex 参考图。

技术参考入口（正式接入时核对最新版本）：[微信登录](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html)、[code2Session](https://developers.weixin.qq.com/miniprogram/dev/OpenApiDoc/user-login/code2Session.html)、[网络要求](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)。本轮网页抓取未能读取微信文档正文，未据此假定账号已满足上线资格。
