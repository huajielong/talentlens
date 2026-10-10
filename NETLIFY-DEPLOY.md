# Netlify 部署

云版使用 PostgreSQL、API Functions 与 Background Functions。本机及 Docker 版本保留 Node.js + SQLite。不要在 Netlify 临时文件系统保存数据库。

## 部署

1. 使用 Node.js 24，运行 `npm ci`。
2. `npx netlify login` 登录，`npx netlify link` 选择项目。`.netlify/` 已被 Git 忽略。
3. 在 Netlify 环境变量中配置以下值，作用域包含 Functions：

| 变量 | 用途 |
|---|---|
| `LLM_PROVIDER` | DeepSeek 设置为 `deepseek` |
| `DEEPSEEK_API_KEY` | 服务端模型密钥 |
| `DEEPSEEK_MODEL` | 模型名称，例如 `deepseek-flash` |
| `GITHUB_TOKEN` | 可选，提升 GitHub 请求额度 |
| `TALENTLENS_SETUP_TOKEN` | 至少 32 位随机令牌，用于首次创建管理员 |
| `TALENTLENS_WORKER_SECRET` | 另一个至少 32 位随机令牌，用于后台调用签名 |

也支持 `OPENAI_API_KEY`、`OPENAI_MODEL`、`OPENAI_BASE_URL`。所有密钥仅在服务端读取，不要写入 GitHub 或 `netlify.toml`。

4. `@netlify/database` 和 `netlify/database/migrations/` 让 Netlify 自动创建数据库并应用迁移。不手工在生产数据库执行建表。
5. 先运行 `npx netlify deploy` 验证，再运行 `npx netlify deploy --prod` 发布；CLI 默认执行构建。也可连接 GitHub 持续部署。
6. 打开正式地址，输入初始化令牌创建公司和管理员。云数据库初始为空，本机客户数据不会自动上传。登录后可使用页面备份导入功能。

## 行为与限制

- 顾问岗位隔离；管理员可查看全部并分配负责人。更新使用版本号保护，事务保护任务领取和预算。
- 人才评估后台运行，最多同时领取两个任务。后台入口验证有时效的 HMAC 签名。
- 工作空间请求最多每分钟补充调度一次；中断超过 16 分钟的任务标记失败，需人工重试。
- JD 解析每次模型请求最多 22 秒，修正最多一次；后台模型请求最多 60 秒。
- 云版不执行 SQLite 自动备份。页面导出备份只包含岗位和结果，不包含账号、审计和预算。数据库快照策略需另行配置。
- Netlify 数据库、函数和带宽消耗套餐 credits，模型费用另计。本项目没有启用付费升级或自动充值。
- 国内访问需要在客户实际网络测试。

## 检查

```sh
npm test
npm run test:cloud
npm run build
```

云版测试使用 PGlite PostgreSQL 引擎验证权限隔离、版本冲突、取消、预算、会话撤销、CSRF 和后台签名。PGlite 是单进程环境，不能替代部署后的并发负载测试。
