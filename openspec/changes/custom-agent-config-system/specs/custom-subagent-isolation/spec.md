## ADDED Requirements

### Requirement: Hard Isolation — task 工具运行时校验 subagent 访问权限
系统 SHALL 在 `task` 工具的 `resolveSubagentExecution()` 执行路径中，当 `subagent_type` 对应一个 custom agent 时，校验调用方 agent（`toolContext.agent`）是否被授权访问该 subagent。

校验逻辑：
1. 获取调用方 agent 名称：`callerAgent = toolContext.agent`
2. 查询 custom agents 注册表：`callerConfig = customAgentsRegistry.get(callerAgent)`
3. 如果 `callerConfig` 存在（调用方是 custom primary）：
   - 检查 `args.subagent_type` 是否在 `callerConfig.subagents[].name` 中
   - 不在则返回 error 字符串，拒绝委派
4. 如果 `callerConfig` 不存在（调用方是内置 agent 如 Sisyphus）：
   - 检查目标 `subagent_type` 是否是 custom subagent
   - 是 custom subagent 则返回 error，内置 agent 不能委派 custom subagents

#### Scenario: Custom primary 委派其配置列表内的 subagent
- **WHEN** "code-guardian"（primary）调用 `task(subagent_type="security-checker")`
- **THEN** "security-checker" 在 "code-guardian" 的 subagents 列表中
- **THEN** task 工具 SHALL 正常执行，不触发 isolation 错误

#### Scenario: Custom primary 尝试委派不在其列表的 subagent
- **WHEN** "code-guardian"（primary）调用 `task(subagent_type="perf-analyzer")`
- **THEN** "perf-analyzer" 不在 "code-guardian" 的 subagents 列表中
- **THEN** task 工具 SHALL 返回 error：`"code-guardian" is not authorized to delegate to "perf-analyzer"`
- **THEN** task 工具 SHALL NOT 创建任何新会话

#### Scenario: 内置 agent Sisyphus 尝试委派 custom subagent
- **WHEN** Sisyphus 调用 `task(subagent_type="security-checker")`
- **THEN** "security-checker" 是 custom subagent，不在 Sisyphus 的授权范围内
- **THEN** task 工具 SHALL 返回 error 并拒绝委派

#### Scenario: Custom primary 委派内置 subagent（如 sisyphus-junior）
- **WHEN** custom primary 配置 `tools: ["task"]` 并调用 `task(subagent_type="sisyphus-junior")`
- **THEN** "sisyphus-junior" 不在 custom primary 的 subagents 配置列表中
- **THEN** task 工具 SHALL 拒绝委派，返回 isolation error

---

### Requirement: Soft Isolation — primary prompt 中声明委派限制
系统 SHALL 在 custom primary 的 prompt 的 `<Constraints>` 区块中明确列出允许委派的 subagent 名称列表，并要求 agent 只能使用列表内的名称调用 `task` 工具。

#### Scenario: Prompt 中含有允许的 subagent 名称白名单
- **WHEN** "code-guardian" 有 subagents: ["security-checker", "perf-analyzer"]
- **THEN** 生成的 prompt Constraints 区块 SHALL 包含：`You MUST ONLY delegate to these subagents: security-checker, perf-analyzer`

---

### Requirement: default_skills 在委派时自动注入
系统 SHALL 在 task 工具执行 custom subagent 委派时，查询对应的 SubagentRef 配置，将 `default_skills` 追加到 `load_skills` 参数中。

追加逻辑：`effective_skills = args.load_skills + subagentRef.default_skills`（去重）

#### Scenario: 委派时自动注入 default_skills
- **WHEN** "code-guardian" 调用 `task(subagent_type="security-checker", load_skills=[])`
- **THEN** "security-checker" 的 SubagentRef 配置 `default_skills: ["code-audit"]`
- **THEN** 实际注入的 skills SHALL 为 `["code-audit"]`

#### Scenario: 调用方显式传入 load_skills 时合并不重复
- **WHEN** "code-guardian" 调用 `task(subagent_type="security-checker", load_skills=["my-skill"])`
- **THEN** 配置 `default_skills: ["code-audit"]`
- **THEN** 实际注入的 skills SHALL 为 `["my-skill", "code-audit"]`（去重）

#### Scenario: 内置 agent 调用 task 时不触发 default_skills 逻辑
- **WHEN** Sisyphus 调用 `task(subagent_type="sisyphus-junior", load_skills=["some-skill"])`
- **THEN** isolation 已经在此之前拒绝了对 custom subagent 的访问
- **THEN** 内置 subagent 的调用流程 SHALL 与修改前完全一致
