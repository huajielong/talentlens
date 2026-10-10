# TalentLens · 客户团队使用版

以岗位 JD 为标准，结合 GitHub 公开仓库证据整理人才技能画像。开源许可证：MIT。

支持本机/Docker 的 Node.js + SQLite，以及 Netlify 的 Functions + PostgreSQL + 后台任务。云版步骤见 [NETLIFY-DEPLOY.md](NETLIFY-DEPLOY.md)，运行检查先执行 `npm ci`。

仓库不包含 API 密钥、运行数据库和客户资料。首次部署需配置模型密钥及初始化令牌，再创建管理员。

客户版已加入登录、顾问岗位隔离、管理员分配、SQLite 保存、用量预算、人工复核及审计。首次打开由负责人创建管理员，已有 JSON 数据自动迁入。部署、备份恢复与验收见 [CUSTOMER-DELIVERY.md](CUSTOMER-DELIVERY.md)。


需要 Node.js 22.13+（客户服务器推荐 Node.js 24 LTS），无须安装依赖。将 `.env.example` 复制为 `.env`，在本机填写 `DEEPSEEK_API_KEY`。不要把密钥发到聊天中。默认模型为 `deepseek-flash`，地址为 `https://api.deepseek.com`。可选 `GITHUB_TOKEN`。

兼容现有配置：当 `OPENAI_BASE_URL` 为 DeepSeek 官方地址时，自动使用 DeepSeek Chat Completions，可继续使用 `OPENAI_API_KEY` 和 `OPENAI_MODEL`。也支持 `LLM_PROVIDER=deepseek`、`DEEPSEEK_MODEL` 和 `DEEPSEEK_BASE_URL`。OpenAI 配置仍使用 Responses API。

DeepSeek 使用 JSON Output，服务端执行完整字段类型、必填项、范围和证据校验，不依赖模型保证 JSON Schema。密钥不会发送给浏览器。

JD 引用校验容忍空格和换行格式差异，并恢复为真实原文。模型改写或拼接引用时，服务端自动带校验反馈修正一次；仍失败则明确提示是哪项标准有问题。`node test-jd.mjs` 验证引用归一化、拒绝改写、修正重试和重试上限。

```powershell
node --env-file=.env server.mjs
```

打开 http://127.0.0.1:4173 。不要直接打开 HTML 或用纯静态服务器，LLM 功能需要此后端服务。密钥仅在服务端读取；`.env` 已被 Git 忽略。

第一步通过 LLM 从 JD 生成岗位摘要、评估标准、权重、原文依据、公开可验证性、评分规则和验证问题。第二步服务端读取公开 GitHub 资料，并让 LLM 按这些标准逐项评估，返回评分或待验证、置信度、证据引用和理由。服务端拒绝虚构证据 ID、缺失标准和无效评分。

最多读取 300 个公开原创仓库，按岗位技能、语言、主题及描述的相关性排序，而不是只按更新时间。模型读取最多 60 个仓库摘要、前 8 份 README，以及前 3 个相关仓库的依赖文件。个人账号额外采集作者身份匹配的提交与公开 PR；提交记录只是贡献线索，不等于代码质量已验证。采集范围及来源类型可在详情中查看。

分开显示有证据技能匹配度、证据覆盖率和待验证项数。匹配度只汇总可公开验证且确实有评分的项；没有证据保持待验证。覆盖率按可公开验证标准的权重计算。只修改权重直接重算，不调用 LLM；修改标准内容后需重新评估。可以编辑标准名称、要求、原文、评分规则及验证问题，自定义标准可不填写 JD 引用。

JD 和公开 GitHub 资料会发送至配置的 LLM API；数据保留取决于该服务商政策。OpenAI 路径使用 store:false，DeepSeek 路径不发送此参数。模型指令要求将仓库文本和 JD 作为不可信证据，不遵从其中指令。应用只辅助专业技能沟通，不自动作出招聘决定。

岗位、结果、追踪及任务保存在 `data/talentlens.sqlite`；浏览器只保留当前账号的会话级输入草稿。首次创建管理员会迁入旧 `data/workspace.json`。可创建并切换多个独立岗位；备份/导入包含全部岗位、标准及结果，不含 API 密钥。导入合并保存，原岗位保留。清空按钮仅清空当前岗位结果。

每次最多评估 10 个待评估账号，自动跳过当前标准下已有结果，输入框中对应文字显示绿色。剩余账号可下一批继续。任务在后端排队执行，可取消、失败单项重试；刷新页面恢复进度，服务重启后重新执行未完成任务。任务历史保留 30 天。相同账号与标准的采集资料缓存 1 小时供重试复用；详情的更新评估绕过缓存。采集超过 7 天提示过期；旧记录没有可靠采集时间时明确标记。

个人与组织分别排序并可筛选，组织分数仅表示项目相关性。默认收起匹配详情；展开后优先展示优势、缺口与待沟通项，长分析及逐项来源默认折叠。结果可删除并撤销；CSV 仅导出当前搜索、类型及追踪筛选下的列表，并包含覆盖率与待验证数量。

离线验证，不消耗 API 额度：

```powershell
node --check server.mjs
node --check dist/app.js
node test.mjs
node test-jd.mjs
node test-deepseek.mjs
node test-batch.mjs
node test-optimized.mjs
node test-http.mjs
node test-customer.mjs
```

`test-optimized.mjs` 覆盖评分口径、权重复用、标准失效、仓库相关性、作者归属、模型输出修复、证据缓存、独立岗位、保存恢复、任务去重、取消及服务重启恢复。`quality-fixtures.json` 是人工定义的边界案例，不代表模型招聘评估准确率；真实评分质量仍需人工标注样本进行校准。

真实调用已验证：DeepSeek 解析示例 JD，以及使用 octocat 公开资料完成两项标准的评估（11 条资料来源）。`node --env-file=.env live-smoke.mjs` 可以重新执行这项检查，会消耗少量 API 额度。

当前为带登录与数据库的 Node 服务实现，提供 Docker + HTTPS 代理部署配置。原 `.openai/hosting.json` 是静态站点配置，不能运行 LLM 后端。在线发布需迁移为 Worker 服务并配置服务端密钥；本轮未上传或发布源码。

API 依据：https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses

DeepSeek 接入依据：https://api-docs.deepseek.com/guides/json_mode/

UI prototype: ui-prototype.png, generated using built-in ImageGen. Prompt: high-fidelity TalentLens recruiter workspace, Chinese interface, warm white / gray minimalist OpenAI-like aesthetic, JD parsing card, batch GitHub input, candidate evidence coverage list, skills profile panel, labeled sample data.
