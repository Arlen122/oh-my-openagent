## 1. 配置 Schema 与加载模块

- [x] 1.1 创建 `src/agents/custom-agents/` 目录及 `index.ts` 入口文件
- [x] 1.2 在 `src/agents/custom-agents/config-schema.ts` 中用 Zod 定义 `CustomAgentConfigSchema`（AgentConfig、SubagentRef 的完整字段校验）
- [x] 1.3 实现配置校验逻辑：primary 不能被引用为 subagent
- [x] 1.4 实现配置校验逻辑：agent name 不能与内置 agent 名称冲突（大小写不敏感）
- [x] 1.5 实现配置校验逻辑：subagents[].name 引用的 agent 必须在 custom_agents 列表中存在
- [x] 1.6 实现配置校验逻辑：primary 含 subagents 但 tools 不含 task 时打印 warning
- [x] 1.7 在 `src/agents/custom-agents/config-loader.ts` 中实现 `loadCustomAgentsConfig()`，读取 `~/.opencode/custom-agents.json`，文件不存在时返回空数组
- [x] 1.8 为配置加载和校验编写单元测试（合法配置、非法字段、名称冲突、primary 被引用等场景）

## 2. Prompt Builder

- [x] 2.1 在 `src/agents/custom-agents/prompt-builder.ts` 中实现 `buildCustomPrimaryPrompt(config, subagentRefs)`
- [x] 2.2 实现委派表格生成函数 `buildDelegationTable(subagentRefs)`，处理 domain/when_to_use 中的 `|` 字符转义
- [x] 2.3 将 Sisyphus-lite 模板各区块（Role、Delegation_Table、Delegation_Protocol、Session_Continuity、Tool_Constraints、Constraints）组合为完整 prompt
- [x] 2.4 实现 `<Constraints>` 区块中的 Soft Isolation 声明（列出允许委派的 subagent 名称白名单）
- [x] 2.5 对无 subagents 的 primary，生成简化版 prompt（不含 Delegation_Table 和 Session_Continuity 区块）
- [x] 2.6 为 prompt builder 编写快照测试（验证生成的 prompt 结构）

## 3. Agent 工厂与注册

- [x] 3.1 在 `src/agents/custom-agents/agent-factory.ts` 中实现 `buildCustomAgentConfig(agentDef)`，将配置对象转换为 `AgentConfig`
- [x] 3.2 实现 primary agent 的 permission 配置：`tools` 白名单 → allow，其余 → deny，task/call_omo_agent 按规则处理
- [x] 3.3 实现 subagent 的 permission 配置：`task: "deny"`，`call_omo_agent: "deny"`，`tools` 白名单 → allow
- [x] 3.4 实现 `createCustomAgents(config)` 函数，遍历配置生成所有 custom AgentConfig 对象的 Map
- [x] 3.5 在 `src/agents/builtin-agents.ts` 的 `createBuiltinAgents()` 末尾调用 `createCustomAgents()` 并合并结果（custom agents 不加入 `availableAgents` 列表，确保 Sisyphus 不可见）

## 4. Custom Agents 注册表（Isolation 数据结构）

- [x] 4.1 创建 `CustomAgentsRegistry` 单例或模块级 Map，存储 `{ primaryAgentName → SubagentRef[] }` 的映射关系
- [x] 4.2 在 `createCustomAgents()` 中填充注册表
- [x] 4.3 确认 `toolContext.agent` 在 OMO 工具执行上下文中可用且准确（阅读 SDK 源码或现有工具实现确认）

## 5. Task 工具 Hard Isolation

- [x] 5.1 找到 `src/tools/delegate-task/` 中的 `resolveSubagentExecution()` 函数位置
- [x] 5.2 在 `resolveSubagentExecution()` 中注入 `CustomAgentsRegistry` 查询逻辑
- [x] 5.3 实现 isolation 校验：custom primary 只能委派其 subagents 列表中的 agent，否则返回 error 字符串
- [x] 5.4 实现 isolation 校验：内置 agent（如 Sisyphus）不能委派 custom subagents
- [x] 5.5 实现 `default_skills` 自动注入逻辑：委派 custom subagent 时，将 SubagentRef.default_skills 追加到 load_skills（去重）
- [x] 5.6 为 isolation 逻辑编写单元测试（授权场景、越权场景、内置 agent 越界场景）

## 6. 集成测试与文档

- [x] 6.1 编写集成测试：完整加载 custom-agents.json → 注册 agents → 验证 permission 配置正确
- [x] 6.2 编写集成测试：task 工具 isolation 校验 end-to-end（mock toolContext.agent）
- [x] 6.3 创建示例配置文件 `examples/custom-agents.example.json`，包含一个 primary + 两个 subagents 的完整示例
- [x] 6.4 在 `omo-analysis-report.md` 或项目 README 中补充 custom agents 配置说明章节
