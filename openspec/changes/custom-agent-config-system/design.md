## Context

OMO 通过 `createBuiltinAgents()` 在插件启动时创建所有 agent，并通过 opencode 的 `config` hook 注入到 agent 列表。每个内置 agent 是一个工厂函数（`AgentFactory`）或静态 `AgentConfig` 对象，由源码硬编码定义。

当前扩展点：用户可通过 `oh-my-opencode.json` 的 `agents` 字段覆盖内置 agent 的 `model`、`prompt_append` 等属性，但无法新增 agent。OpenCode 原生支持 `.claude/agents/*.md` 格式的项目级 agent，OMO 已通过 `parseRegisteredAgentSummaries()` 读取其摘要并注入 Sisyphus prompt，但这些 agent 对 Sisyphus 是只读可见的，不能形成独立的 orchestrator 体系。

本设计在 OMO 层面新增声明式 custom agent 系统，目标是让用户通过 JSON 配置就能构建与 Sisyphus 平行的 agent 生态。

## Goals / Non-Goals

**Goals:**
- 支持通过 `~/.opencode/custom-agents.json` 定义 primary 和 subagent
- Primary agent 拥有自动生成的 orchestrator prompt（含委派表格、会话连续性约束）
- 每个 primary 只能委派其配置列表中的 subagents（Hard Isolation）
- 与 Sisyphus 完全平行，互不知晓
- 无 breaking changes，所有内置 agent 行为不变

**Non-Goals:**
- 不支持 custom agent 调用 Sisyphus 内置 subagents（如 oracle、explore）
- 不支持 primary agent 之间的相互感知或协作
- 不支持动态热更新（需重启 opencode 生效）
- 不修改 OpenCode 原生 `.claude/agents/*.md` 的加载逻辑

## Decisions

### D1：配置文件位置 — 全局独立文件

**选择**：`~/.opencode/custom-agents.json`，与 `oh-my-opencode.json` 平级，独立文件。

**原因**：
- `oh-my-opencode.json` 有严格的 Zod schema 校验，合并进去会让 schema 变复杂，且现有 migration 逻辑需要修改
- 独立文件语义更清晰，配置加载失败时不影响主配置
- 用户可以独立维护 custom agents，不与 OMO 版本升级的配置格式耦合

**备选**：合并到 `oh-my-opencode.json` 的 `custom_agents` 字段 → 拒绝（schema 污染）

---

### D2：Primary Agent Prompt — Sisyphus-lite 固定模板

**选择**：提供一个固定的"Sisyphus-lite"模板，动态插入以下部分：
- `<Role>`：来自 `system_instructions` 字段
- `<Delegation_Table>`：来自 `subagents` 列表的 domain/when_to_use 字段自动生成
- `<Session_Continuity>`：固定规则（保存并复用 session_id）
- `<Tool_Constraints>`：来自 tools 白名单

**原因**：
- 不支持意图门控（Intent Gate）——它依赖 explore/librarian 等内置 agent，custom primary 没有
- 用户通过 `system_instructions` 自行控制行为风格（先调查 or 直接执行）
- 三档模板选项（full/lite/minimal）复杂度过高，对用户不友好
- 固定模板保证行为可预期，调试成本低

**备选**：`prompt_template: "sisyphus-full" | "lite" | "minimal"` 三档选项 → 拒绝（复杂，维护负担高）

---

### D3：Subagent 隔离 — Hard Isolation（Runtime 校验）

**选择**：在 `task` 工具的 `resolveSubagentExecution()` 中，运行时检查调用方 agent 是否被授权使用目标 subagent：

```typescript
const callerAgent = toolContext.agent
const customConfig = customAgentsRegistry.getPrimaryConfig(callerAgent)
if (customConfig) {
  const allowed = customConfig.subagents.map(s => s.name)
  if (!allowed.includes(args.subagent_type)) {
    return `Error: "${callerAgent}" is not authorized to delegate to "${args.subagent_type}"`
  }
}
```

同时在 primary 的 prompt 里加 Soft Isolation 说明（双重保险）。

**原因**：
- Soft Isolation 单独依赖 LLM 遵守 prompt 约束，存在被绕过的风险
- Hard Isolation 在工具层直接拦截，可靠性高
- `toolContext.agent` 在 OMO 的 `ToolContext` 中已经可用

**备选**：仅 Soft Isolation（prompt 约束）→ 拒绝（可靠性不够）

---

### D4：Skills 设计 — Primary 无 skills 字段，委派时通过 default_skills 注入

**选择**：
- `subagent` 配置无 `skills` 字段
- Primary 的 `subagents` 引用列表支持 `default_skills` 字段，委派时自动传入 `load_skills`

```json
{
  "name": "code-guardian",
  "mode": "primary",
  "subagents": [
    {
      "name": "security-checker",
      "default_skills": ["code-audit"]
    }
  ]
}
```

**原因**：
- 与原版 OMO 的 skill 机制一致：primary 决定注入什么 skill，subagent 被动接收
- 避免语义歧义（subagent 的 `skills` 字段不清楚是"主动读取"还是"被动注入"）
- 实现路径清晰：在 `resolveSubagentExecution()` 里查找 custom config 的 `default_skills` 并追加到 `load_skills`

---

### D5：Tools 配置 — 白名单 list[str]，空列表 = 无工具

**选择**：`tools` 字段为字符串数组，列出允许使用的工具名称。空数组 `[]` 表示该 agent 没有任何工具。Primary 默认应包含 `"task"` 才能委派，否则无法委派。

**验证**：配置加载时检查：
- 如果 mode 为 `primary` 且 `tools` 不包含 `"task"`，且有 `subagents` 配置时，输出 warning（不 hard fail，允许用户故意这样配）

---

### D6：Custom Agents 注册 — 注入 createBuiltinAgents 末尾

**选择**：在 `createBuiltinAgents()` 末尾调用 `createCustomAgents()`，结果与内置 agents 合并后返回。Custom agents 不出现在 `availableAgents`（即 Sisyphus 的委派表格），完全隔离。

```typescript
// builtin-agents.ts 末尾
const customAgents = await createCustomAgents(customAgentsConfig, toolPermissions)
return {
  ...sisyphusResult,
  ...pendingAgentConfigs,
  ...customAgents,  // 注入，但不影响 sisyphus 的 availableAgents
}
```

## Risks / Trade-offs

**[R1] Primary agent prompt 质量完全依赖 system_instructions 的质量**
→ 缓解：在文档和配置示例中提供写好 system_instructions 的最佳实践和模板

**[R2] task 工具 isolation 校验依赖 toolContext.agent 的准确性**
→ 缓解：验证 opencode SDK 中 `context.agent` 在子会话中是否正确反映 caller agent 名称（需要集成测试覆盖）

**[R3] 配置文件不存在时的降级行为**
→ 缓解：`loadCustomAgentsConfig()` 文件不存在时返回空数组，不报错，系统正常运行

**[R4] custom agent 名称与内置 agent 名称冲突**
→ 缓解：配置加载时检查名称是否与内置 agent（sisyphus、oracle 等）重名，冲突则 skip 并打印 warning

**[R5] subagent 被多个 primary 引用，但各 primary 都有访问权**
→ 这是合理的设计：同一个 subagent 可以为不同 primary 服务，isolation 是"primary 不能越界调用自己没配的 subagent"，不是"subagent 只能被一个 primary 用"

## Open Questions

- **Q1**：`toolContext.agent` 在 OMO 的工具执行上下文中是否稳定可靠，能否准确反映调用方 agent 名称？需要阅读 SDK 源码确认。
- **Q2**：custom primary agent 是否也应支持 `color` 字段（UI 颜色）？opencode SDK 的 `AgentConfig` 是否有此字段？
- **Q3**：全局配置文件的 hot reload 是否值得实现（v2 考虑）？
