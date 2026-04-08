## ADDED Requirements

### Requirement: 配置文件格式与字段定义
系统 SHALL 支持在 `~/.opencode/custom-agents.json` 中声明 custom agent 配置，文件为 JSON 格式，顶层结构为 `{ "custom_agents": AgentConfig[] }`。

每个 AgentConfig 对象 SHALL 支持以下字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 必填 | agent 唯一标识，kebab-case，不能与内置 agent 名称冲突 |
| `mode` | `"primary" \| "subagent" \| "all"` | 必填 | agent 类型 |
| `description` | string | 必填 | agent 功能描述，用于 UI 显示 |
| `model` | string | 必填 | 模型标识符，格式为 `provider/model-id` |
| `system_instructions` | string | 必填 | agent 的角色与行为描述，注入到 prompt 的 `<Role>` 区块 |
| `tools` | string[] | 必填 | 允许使用的工具白名单，空数组表示无工具 |
| `color` | string | 可选 | UI 显示颜色，CSS hex 格式（如 `"#FF6B6B"`） |
| `subagents` | SubagentRef[] | 可选 | 仅 primary/all 有效，声明可委派的 subagent 列表 |

SubagentRef 对象字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 必填 | 引用的 subagent 名称，必须在 custom_agents 中存在 |
| `domain` | string | 必填 | 该 subagent 负责的领域，用于生成委派表格 |
| `when_to_use` | string | 必填 | 委派触发条件描述，用于生成委派表格 |
| `default_skills` | string[] | 可选 | 委派时自动注入的 skills，追加到 `load_skills` |

#### Scenario: 完整合法配置解析成功
- **WHEN** `custom-agents.json` 包含所有必填字段且格式正确
- **THEN** 系统 SHALL 成功解析并返回类型化的配置对象

#### Scenario: 缺少必填字段时报告错误
- **WHEN** 某个 agent 配置缺少 `name`、`mode`、`system_instructions` 等必填字段
- **THEN** 系统 SHALL 跳过该 agent 并打印 warning，不影响其他 agents 加载

#### Scenario: mode 字段非法值拒绝
- **WHEN** agent 的 `mode` 字段不是 `"primary"`、`"subagent"`、`"all"` 之一
- **THEN** 系统 SHALL 跳过该 agent 并打印具体错误信息

---

### Requirement: Primary agent 不能出现在 subagents 引用列表
系统 SHALL 在配置校验阶段检查：mode 为 `primary` 的 agent 不能出现在任何其他 agent 的 `subagents` 引用中。

#### Scenario: Primary 被引用为 subagent 时报警告
- **WHEN** agent A（mode: primary）的名称出现在 agent B 的 `subagents[].name` 中
- **THEN** 系统 SHALL 从 agent B 的 subagents 列表中移除该引用，并打印 warning

---

### Requirement: Agent 名称不能与内置 agent 冲突
系统 SHALL 检查 custom agent 的 `name` 字段是否与内置 agent 名称（sisyphus、oracle、explore、librarian、metis、momus、atlas、hephaestus、sisyphus-junior 等）重复。

#### Scenario: 名称冲突时跳过该 agent
- **WHEN** custom agent 的 name 与内置 agent 名称完全相同（大小写不敏感）
- **THEN** 系统 SHALL 跳过该 custom agent 并打印 warning，内置 agent 不受影响

---

### Requirement: SubagentRef 引用的 agent 必须存在
系统 SHALL 校验 `subagents[].name` 引用的 agent 在 `custom_agents` 列表中实际存在。

#### Scenario: 引用不存在的 subagent
- **WHEN** primary 的 `subagents[].name` 指向的 agent 在配置中不存在
- **THEN** 系统 SHALL 从该 primary 的 subagents 列表移除该无效引用，并打印 warning

---

### Requirement: Primary 配置 subagents 但 tools 不含 task 时发出警告
系统 SHALL 检查：如果 mode 为 `primary`，且配置了非空 `subagents` 列表，但 `tools` 数组不包含 `"task"` 工具，则发出 warning。

#### Scenario: 缺少 task 工具权限但有 subagents 配置
- **WHEN** primary agent 的 `tools` 不含 `"task"`，且 `subagents` 列表非空
- **THEN** 系统 SHALL 打印 warning 提示"primary agent has subagents configured but task tool not in tools list"，仍然注册该 agent（不 hard fail）

---

### Requirement: 配置文件不存在时静默降级
系统 SHALL 在 `~/.opencode/custom-agents.json` 文件不存在时，返回空 agent 列表并正常运行，不报错。

#### Scenario: 配置文件缺失
- **WHEN** `~/.opencode/custom-agents.json` 文件不存在
- **THEN** 系统 SHALL 返回空数组，不抛出异常，系统正常启动
