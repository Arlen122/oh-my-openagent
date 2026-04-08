## ADDED Requirements

### Requirement: 加载并注册 custom agents 到 opencode
系统 SHALL 在 `createBuiltinAgents()` 末尾调用 `createCustomAgents()`，将解析后的 custom agents 转换为 `AgentConfig` 对象，合并进 opencode agent 注册表并返回。

#### Scenario: 存在合法 custom agents 时成功注册
- **WHEN** `custom-agents.json` 中有合法的 custom agent 配置
- **THEN** 系统 SHALL 将这些 agents 作为 `AgentConfig` 对象注册到 opencode
- **THEN** primary agents SHALL 出现在 opencode 的 UI 模型选择器中

#### Scenario: 没有 custom agents 时不影响内置 agents
- **WHEN** `custom-agents.json` 不存在或 `custom_agents` 为空数组
- **THEN** `createBuiltinAgents()` 的返回结果 SHALL 与原来完全一致

---

### Requirement: Custom agents 与 Sisyphus 完全隔离
系统 SHALL 确保 custom agents（primary 和 subagent）不出现在 Sisyphus（及 Hephaestus、Atlas）的 `availableAgents` 列表中。

#### Scenario: Sisyphus 不知道 custom agents 的存在
- **WHEN** 系统注册了 custom primary agent "code-guardian" 及其 subagent "security-checker"
- **THEN** Sisyphus 的委派表格中 SHALL NOT 出现 "code-guardian" 或 "security-checker"
- **THEN** Sisyphus 调用 `task(subagent_type="security-checker")` SHALL 触发 isolation 校验拒绝（见 custom-subagent-isolation spec）

---

### Requirement: Custom subagent 的工具权限配置
系统 SHALL 为 custom subagent 设置以下默认权限：
- `task: "deny"`（不允许再次委派）
- `call_omo_agent: "deny"`

config 中 `tools` 白名单里的工具 SHALL 被设置为 `"allow"`，不在白名单中的工具 SHALL 被设置为 `"deny"`。

#### Scenario: Subagent tools 白名单生效
- **WHEN** custom subagent 配置 `tools: ["bash", "read_file"]`
- **THEN** 该 agent 在 opencode 中 SHALL 拥有 bash 和 read_file 工具权限
- **THEN** task、write_file 等未列出的工具 SHALL 对该 agent 不可见

---

### Requirement: Custom primary agent 的工具权限配置
系统 SHALL 为 custom primary agent 根据 `tools` 白名单设置权限，并强制：
- 如果 `tools` 含 `"task"`：`task: "allow"`，`call_omo_agent: "deny"`
- 如果 `tools` 不含 `"task"`：`task: "deny"`

#### Scenario: Primary 含 task 工具时可以委派
- **WHEN** custom primary 配置 `tools: ["bash", "read_file", "task"]`
- **THEN** 该 agent SHALL 拥有 task 工具权限，可以通过 task 工具委派 subagent

#### Scenario: Primary 不含 task 工具时无法委派
- **WHEN** custom primary 配置 `tools: ["bash", "read_file"]`（不含 task）
- **THEN** 该 agent SHALL 没有 task 工具权限
