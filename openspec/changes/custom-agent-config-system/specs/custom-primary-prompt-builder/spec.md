## ADDED Requirements

### Requirement: 为 custom primary agent 生成 orchestrator prompt
系统 SHALL 为每个 mode 为 `primary`（或含 primary 语义的 `all`）且有 `subagents` 配置的 custom agent 自动生成 orchestrator prompt，基于 Sisyphus-lite 固定模板。

Prompt 结构 SHALL 包含以下区块（按顺序）：

```
<Role>
  来自 system_instructions 字段
</Role>

<Delegation_Table>
  动态生成的委派表格（来自 subagents 配置）
</Delegation_Table>

<Delegation_Protocol>
  委派格式规范（6 段 prompt 结构要求）
  task 工具参数使用规范
</Delegation_Protocol>

<Session_Continuity>
  固定规则：保存并复用 session_id
  说明 session_id 带来的 token 节省
</Session_Continuity>

<Tool_Constraints>
  来自 tools 白名单的工具使用说明
</Tool_Constraints>

<Constraints>
  只能委派 subagents 列表中的 agent（Soft Isolation 说明）
</Constraints>
```

#### Scenario: 有 subagents 配置的 primary 生成完整 prompt
- **WHEN** custom primary 配置了 `system_instructions` 和非空 `subagents`
- **THEN** 生成的 prompt SHALL 包含所有上述区块
- **THEN** `<Delegation_Table>` SHALL 包含每个 subagent 的 name、domain、when_to_use

#### Scenario: 无 subagents 配置的 primary 生成简化 prompt
- **WHEN** custom primary 配置为空 `subagents: []` 或未配置 subagents
- **THEN** 生成的 prompt SHALL 包含 Role、Tool_Constraints、Constraints 区块
- **THEN** 不生成 Delegation_Table 和 Session_Continuity 区块（无 subagent 可委派）

---

### Requirement: 委派表格动态生成
系统 SHALL 根据 primary 的 `subagents` 配置动态生成 Markdown 表格，格式为：

```markdown
| Agent | Domain | When to Use |
|-------|--------|-------------|
| {name} | {domain} | {when_to_use} |
```

#### Scenario: 多个 subagents 的表格生成
- **WHEN** primary 配置了 3 个 subagents，各有 domain 和 when_to_use
- **THEN** 生成的表格 SHALL 包含 3 行，每行对应一个 subagent

#### Scenario: domain/when_to_use 含特殊字符时安全处理
- **WHEN** domain 或 when_to_use 字段包含 `|` 字符
- **THEN** 系统 SHALL 转义为 `\|`，确保 Markdown 表格格式正确

---

### Requirement: 会话连续性规则注入
系统 SHALL 在 primary 的 prompt 的 `<Session_Continuity>` 区块中包含以下约束：
1. 每次 `task` 工具调用返回的 `<task_metadata>` 中的 `session_id` 必须保存
2. 对同一 subagent 的后续委派必须传入 `session_id` 参数
3. background 模式下不支持 session_id

#### Scenario: Session continuity 规则存在于 prompt 中
- **WHEN** 生成 custom primary 的 prompt
- **THEN** prompt SHALL 包含关于 session_id 保存和复用的明确指令
- **THEN** 指令格式 SHALL 与 Sisyphus 的 session continuity 规范一致

---

### Requirement: custom subagent 使用 system_instructions 作为直接 prompt
系统 SHALL 对 mode 为 `subagent` 的 custom agent，直接使用 `system_instructions` 字段作为其 `prompt`，不添加额外的模板结构。

#### Scenario: Subagent prompt 直接来自 system_instructions
- **WHEN** custom subagent 配置 `system_instructions: "You are a security expert..."`
- **THEN** 该 agent 在 opencode 中注册的 `prompt` SHALL 等于 `system_instructions` 的内容
