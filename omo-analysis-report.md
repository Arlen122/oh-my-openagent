# oh-my-opencode (OMO) 插件机制分析报告

> 基于 `node_modules/oh-my-opencode/dist/index.js`（145860 行）源码分析  
> 分析重点：插件接入机制、工具注册、Sisyphus Agent 实现

---

## 一、整体架构概览

OMO 是一个 **opencode 插件**，通过 `@opencode-ai/plugin` SDK 提供的钩子体系嵌入 opencode 的运行流程。其核心职责是：

1. **注入自定义工具**（`task`、`call_omo_agent`、`skill` 等）
2. **注册自定义 Agent**（Sisyphus、Oracle、Hephaestus 等）
3. **挂载 Hooks**（拦截工具调用前后、消息变换、上下文注入等）
4. **动态构建系统 Prompt**（根据可用 Agent、工具、技能动态生成）

```
opencode 主进程
    └── 加载插件 (Plugin = (PluginInput) => Promise<Hooks>)
            └── OhMyOpenCodePlugin(ctx)
                    ├── createTools()       → 注册工具
                    ├── createHooks()       → 注册钩子
                    ├── createManagers()    → 创建管理器
                    └── createPluginInterface()  → 汇总为 Hooks 对象返回
```

---

## 二、插件入口与生命周期

### 2.1 插件定义

`@opencode-ai/plugin` 定义的 `Plugin` 类型：

```typescript
type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>
```

OMO 的入口（`src/index.ts`）：

```javascript
// src/index.ts (line 145783)
var OhMyOpenCodePlugin = async (ctx) => {
  const pluginConfig = loadPluginConfig(ctx.directory, ctx);
  const managers = createManagers({ ctx, pluginConfig, ... });
  const toolsResult = await createTools({ ctx, pluginConfig, managers });
  const hooks = createHooks({ ctx, pluginConfig, ..., mergedSkills, availableSkills });
  const dispose = createPluginDispose({ ... });
  const pluginInterface = createPluginInterface({ ctx, pluginConfig, managers, hooks, tools: toolsResult.filteredTools });
  return { name: "oh-my-openagent", ...pluginInterface, "experimental.session.compacting": ... };
};
```

### 2.2 插件上下文（PluginInput）

```typescript
type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>; // opencode REST 客户端
  project: Project;
  directory: string;   // 当前项目目录
  worktree: string;    // Git worktree 根目录
  serverUrl: URL;
  $: BunShell;         // Shell 执行环境
}
```

---

## 三、`@opencode-ai/plugin` SDK 的 Hooks 体系

opencode 的 `Hooks` 接口是插件影响运行机制的核心，主要钩子如下：

| Hook 名称 | 触发时机 | OMO 用途 |
|-----------|---------|---------|
| `tool` | 工具注册 | 注入 `task`、`call_omo_agent`、`skill` 等自定义工具 |
| `chat.message` | 新消息到达 | 触发 first-message variant 覆盖（选择 Agent） |
| `chat.params` | 发送给 LLM 前 | 调整 temperature、topP、thinking 参数 |
| `chat.headers` | 发送 HTTP 请求前 | 注入自定义请求头 |
| `command.execute.before` | 斜杠命令执行前 | 拦截并转换 slash commands |
| `tool.execute.before` | 工具调用前 | 参数修改、安全校验（null byte 清理等） |
| `tool.execute.after` | 工具调用后 | 输出截断、格式化 |
| `experimental.chat.messages.transform` | 消息列表变换 | Context Injector 注入历史上下文 |
| `experimental.chat.system.transform` | 系统 prompt 变换 | （当前为空实现，Agent 注册走 config hook） |
| `experimental.session.compacting` | 会话压缩前 | 保留 TODO、注入压缩上下文 |
| `config` | 配置加载时 | 通过 event handler 动态注册 Agent |

---

## 四、工具注册机制（createToolRegistry）

```
createTools()
  └── createSkillContext()         → 加载技能文件
  └── createAvailableCategories()  → 构建分类列表
  └── createToolRegistry()         → 创建所有工具并注册
        ├── builtinTools           → 来自 opencode 内置（bash, read, write 等）
        ├── createGrepTools()
        ├── createGlobTools()
        ├── createAstGrepTools()
        ├── createSessionManagerTools()
        ├── createBackgroundTools()   → background_output, background_cancel
        ├── call_omo_agent: createCallOmoAgent()   ← 子 agent 调用工具
        ├── look_at: createLookAt()                ← 多模态工具
        ├── task: createDelegateTask()             ← 核心任务委派工具
        ├── skill_mcp: createSkillMcpTool()
        ├── skill: createSkillTool()
        ├── interactive_bash (可选)
        └── task_create/task_get/task_list/task_update (任务系统可选)
```

### 4.1 工具定义格式（`@opencode-ai/plugin` SDK）

```typescript
// tool.d.ts
tool<Args extends z.ZodRawShape>(input: {
  description: string;
  args: Args;
  execute(args: z.infer<z.ZodObject<Args>>, context: ToolContext): Promise<string>;
}): ToolDefinition;
```

**ToolContext** 提供工具执行时的上下文：
- `sessionID`、`messageID`、`agent`：当前会话信息
- `directory`、`worktree`：项目路径
- `abort`：中断信号
- `metadata()`：向 UI 更新工具标题/元数据
- `ask()`：请求用户权限

工具注册后直接以 `{ [toolName]: ToolDefinition }` 形式作为 Hooks 的 `tool` 字段返回，opencode 主进程接管调度。

---

## 五、Sisyphus Agent 深度分析

Sisyphus 是 OMO 的**主 Orchestrator Agent**，定位为"SF Bay Area 高级工程师"，负责理解意图、规划任务、委派专项工作给子 Agent。

### 5.1 Agent 注册方式

Agent 通过 opencode 的 `config` hook 注册，在 `event` handler 中由 `createBuiltinAgents()` 生成配置对象，最终注入到 opencode 的 agent 列表。

```javascript
// src/agents/builtin-agents.ts (line 140712)
var agentSources = {
  sisyphus: createSisyphusAgent,       // ← 工厂函数（Factory）
  hephaestus: createHephaestusAgent2,
  oracle: createOracleAgent,
  librarian: createLibrarianAgent,
  explore: createExploreAgent,
  "multimodal-looker": createMultimodalLookerAgent,
  metis: createMetisAgent,
  momus: createMomusAgent,
  atlas: createAtlasAgent,
  "sisyphus-junior": createSisyphusJuniorAgentWithOverrides
};
```

### 5.2 Agent 配置对象结构

`createSisyphusAgent()` 返回的配置：

```javascript
{
  description: "Powerful AI orchestrator...",
  mode: "primary",          // 模式：primary（主 agent）或 subagent
  model: "<resolved>",       // 运行时解析的模型
  maxTokens: 64000,
  prompt: "<动态构建的系统 prompt>",
  color: "#00CED1",
  permission: {
    question: "allow",       // 允许提问
    call_omo_agent: "deny"   // 禁止 Sisyphus 使用 call_omo_agent（只能用 task）
  },
  thinking: { type: "enabled", budgetTokens: 32000 },  // Claude 扩展思考
  // 或 reasoningEffort: "medium"  （GPT/Gemini）
}
```

### 5.3 多模型变体（Prompt 自适应）

Sisyphus 根据检测到的模型动态调整系统 Prompt：

```javascript
function createSisyphusAgent(model, availableAgents, ...) {
  if (isGpt5_4Model(model)) {
    // GPT-5.4：8-block XML 结构，紧凑，无需重复强调
    return { ..., prompt: buildGpt54SisyphusPrompt(...), reasoningEffort: "medium" };
  }
  
  let prompt = buildDynamicSisyphusPrompt(model, ...);  // 默认 Claude 版本
  
  if (isGeminiModel(model)) {
    // Gemini：注入矫正层，对抗其"过度乐观"倾向
    prompt = prompt.replace("</intent_verbalization>", 
      `\n${buildGeminiIntentGateEnforcement()}\n${buildGeminiToolMandate()}`);
    // 还会插入工具强制使用指引和委派覆盖
  }
  
  if (isGptModel(model)) {
    return { ...base, reasoningEffort: "medium" };
  }
  return { ...base, thinking: { type: "enabled", budgetTokens: 32000 } };
}
```

三套 Prompt 变体分工：

| 变体 | 文件 | 适用模型 | 设计策略 |
|------|------|---------|---------|
| `buildDynamicSisyphusPrompt` | `sisyphus.ts` | Claude（默认） | 动态组装各模块 |
| `buildDefaultSisyphusPrompt` | `sisyphus/default.ts` | Claude 通用 | 基础实现 |
| `buildGpt54SisyphusPrompt` | `sisyphus/gpt-5-4.ts` | GPT-5.4 | 8-block XML，紧凑 |
| Gemini overlay | `sisyphus/gemini.ts` | Gemini 系列 | 矫正覆盖层 |

### 5.4 动态 Prompt 构建（buildDynamicSisyphusPrompt）

Prompt 由多个子模块动态拼装，最终结构如下：

```
<Role>
  身份定义 + 核心能力 + 运营模式
</Role>
<Behavior_Instructions>
  Phase 0: Intent Gate (意图识别)
    ├── buildKeyTriggersSection()     → 关键触发词表
    ├── <intent_verbalization>        → 意图言语化协议
    ├── Step 1: 请求分类
    ├── Step 1.5: 轮次级意图重置
    ├── Step 2: 歧义检查
    Phase 1: Exploration
    ├── buildExploreSection()         → 探索策略（工具使用规则）
    ├── buildToolSelectionTable()     → 工具选择矩阵表格
    ├── buildLibrarianSection()       → Librarian 使用规则
    Phase 2B: Implementation
    ├── buildCategorySkillsDelegationGuide()  → Category+Skills 委派指南
    ├── buildNonClaudePlannerSection()        → 非 Claude 规划补充
    ├── buildParallelDelegationSection()      → 并行委派策略
    ├── buildDelegationTable()               → Agent 委派表格
    ├── 委派 Prompt 6 段结构规范
    ├── Session 连续性强制要求
    Phase 2C: Failure Recovery
    Phase 3: Completion
</Behavior_Instructions>
buildOracleSection()        → Oracle 咨询规则
buildTaskManagementSection() → Todo/Task 管理规范
<Tone_and_Style>            → 沟通风格约束
<Constraints>
  buildHardBlocksSection()  → 硬性禁止规则
  buildAntiPatternsSection() → 反模式警告
</Constraints>
```

### 5.5 意图门控（Intent Gate）

每条用户消息都必须经过意图分类，Sisyphus 被要求先**言语化意图**再行动：

| 表面形式 | 真实意图 | 路由决策 |
|---------|---------|---------|
| "explain X"、"how does Y work" | 研究/理解 | explore/librarian → 综合 → 回答 |
| "implement X"、"add Y" | 实现（显式） | plan → 委派或执行 |
| "look into X"、"check Y" | 调查 | explore → 汇报发现 |
| "what do you think about X?" | 评估 | 评估 → 提案 → **等待确认** |
| "I'm seeing error X" | 修复需求 | 诊断 → 最小化修复 |

**Turn-Local Intent Reset**：每轮必须从当前消息重新分类意图，禁止从上一轮延续"实现模式"。

### 5.6 Task 管理机制

根据配置切换两种模式：

```javascript
function buildTaskManagementSection(useTaskSystem) {
  if (useTaskSystem) {
    // 使用 TaskCreate/TaskUpdate 工具（结构化任务系统）
    return `<Task_Management>... TaskCreate ... TaskUpdate(status=...) ...`
  }
  // 使用 todowrite 工具（轻量 todo）
  return `<Task_Management>... todowrite ...`
}
```

两种模式工作流相同：
1. 收到请求立即创建任务
2. 开始每步前标记 `in_progress`
3. 完成每步后立即标记 `completed`（禁止批量完成）

---

## 六、子 Agent 调用机制

### 6.1 两个委派工具对比

| 工具 | 调用方 | 目标 | 说明 |
|------|--------|------|------|
| `task` | Sisyphus（主 agent） | 任意 category/subagent_type | **主要委派工具** |
| `call_omo_agent` | 子 Agent（explore/librarian） | 仅 explore/librarian | 轻量子 agent 调用 |

#### 入参对比

**`task` 入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | string | 必填 | 3-5 词任务描述 |
| `prompt` | string | 必填 | 完整任务 prompt，必须用英文 |
| `run_in_background` | boolean | 必填 | true=异步返回 task_id，false=同步等待 |
| `load_skills` | string[] | 必填 | 要注入的技能列表，不需要时传 `[]` |
| `category` | string | 二选一 | 分类名，决定使用哪个模型，自动映射到 sisyphus-junior |
| `subagent_type` | string | 二选一 | 直接指定 agent 类型（不可与 category 同时提供） |
| `session_id` | string | 可选 | 续接已有会话（background 模式下不支持） |
| `command` | string | 可选 | 触发该任务的斜杠命令（追踪用） |

**`call_omo_agent` 入参：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `description` | string | 必填 | 3-5 词任务描述 |
| `prompt` | string | 必填 | 完整任务 prompt，必须用英文 |
| `subagent_type` | string | 必填 | **只允许** `explore` 或 `librarian` |
| `run_in_background` | boolean | 必填 | true=异步，false=同步 |
| `session_id` | string | 可选 | 续接已有会话 |

**关键差异：**
- `task` 有 `load_skills` 和 `category`，功能完整，是主委派工具；`call_omo_agent` 没有这两个参数，是轻量快速调用工具
- `task` 的 `subagent_type` 支持所有 agent；`call_omo_agent` 的 `subagent_type` 仅限 explore/librarian 两种
- `task` 在 background 模式下不支持 `session_id`（互斥）；`call_omo_agent` 无此限制

#### 为什么 Sisyphus 只看到 `task` 而看不到 `call_omo_agent`

这是 OMO **故意设计的权限隔离**，通过两层机制实现：

**第一层：Agent permission 配置**

```javascript
// src/plugin-handlers（line 143806）
sisyphus.permission = {
  call_omo_agent: "deny",   // 明确拒绝
  task: "allow",             // 明确允许
  "task_*": "allow",
  ...
};
```

opencode 的 `permission` 字段是 Agent 级别的工具白名单/黑名单，值为 `"deny"` 时 opencode 主进程不将该工具暴露给此 Agent，LLM 完全看不到它的存在。

**第二层：全局配置默认锁**

```javascript
// 全局默认：task 工具对普通会话不可见
params.config.permission = {
  ...params.config.permission,
  task: "deny"   // 只有被明确 allow 的 agent 才能用
};
```

**各 Agent 工具可见性矩阵：**

```
              task    call_omo_agent
Sisyphus      allow   deny          ← 主 orchestrator，只用 task 委派
Hephaestus    allow   deny          ← 同上
sisyphus-jr   allow   (继承默认)    ← 执行者，可以继续子委派
explore       deny    可使用         ← 只能被调用，不能委派
librarian     deny    可使用         ← 同上
oracle        deny    deny           ← 只读顾问，不委派任何工具
普通会话        deny    (不限)         ← 全局默认不可用 task
```

`call_omo_agent` 是为子 agent（explore/librarian）准备的，让它们在执行期间可以再发起轻量探索；Sisyphus 作为顶层 orchestrator 只用功能更完整的 `task`，避免绕过 category/skill 系统。

Sisyphus 的 permission 设置中 `call_omo_agent: "deny"`，确保 Sisyphus 只能用 `task` 工具委派。

### 6.2 `task` 工具（createDelegateTask）核心流程

```
task(category="quick", load_skills=[], description="...", prompt="...", run_in_background=false)
  │
  ├── 验证参数（description、run_in_background、load_skills 均必填）
  ├── 解析 Skills 内容（resolveSkillContent）
  ├── 解析父上下文（resolveParentContext）：继承 agent、model
  │
  ├── [有 session_id] → 续接已有会话
  │     ├── background: executeBackgroundContinuation()
  │     └── sync: executeSyncContinuation()
  │
  ├── [有 category] → resolveCategoryExecution()
  │     ├── 将 subagent_type 强制设为 "sisyphus-junior"
  │     ├── 解析分类对应的模型配置
  │     └── 构建 categoryPromptAppend
  │
  ├── [有 subagent_type] → resolveSubagentExecution()
  │     └── 直接解析 agent 配置
  │
  ├── buildSystemContent()   → 组装 system prompt（skill + category prompt + agents context）
  │
  ├── [run_in_background=true]  → executeBackgroundTask()   （异步，返回 task_id）
  └── [run_in_background=false] → executeSyncTask()         （同步，等待完成）
```

### 6.3 同步任务执行（executeSyncTask）

```javascript
async function executeSync(args, toolContext, ctx, deps, fallbackChain, spawnReservation, model) {
  // 1. 创建或获取 opencode session
  const session = await deps.createOrGetSession(args, toolContext, ctx);
  sessionID = session.sessionID;

  // 2. 设置 fallback chain（模型降级链）
  if (fallbackChain?.length > 0) {
    deps.setSessionFallbackChain(sessionID, fallbackChain);
  }

  // 3. 通过 opencode REST API 发送 prompt
  await ctx.client.session.promptAsync({
    path: { id: sessionID },
    body: {
      agent: args.subagent_type,
      tools: {
        ...getAgentToolRestrictions(args.subagent_type),
        task: false,       // 子 agent 禁止再次委派
        question: false
      },
      parts: [{ type: "text", text: args.prompt }],
      model: { providerID, modelID },
    }
  });

  // 4. 轮询等待完成（pollSyncSession）
  await deps.waitForCompletion(sessionID, toolContext, ctx);
  
  // 5. 提取结果文本
  const responseText = await deps.processMessages(sessionID, ctx);
  
  // 6. 返回含 session_id 的结果（支持后续续接）
  return responseText + `\n\n<task_metadata>\nsession_id: ${sessionID}\n</task_metadata>`;
}
```

### 6.4 轮询机制（pollSyncSession）

```javascript
while (Date.now() - pollStart < maxPollTimeMs) {
  await wait(POLL_INTERVAL_MS);  // 每 1 秒轮询

  // 检查 session 状态（idle = 可能完成）
  const sessionStatus = allStatuses[sessionID];
  if (sessionStatus.type !== "idle") continue;

  // 拉取消息，检查是否真正完成
  if (isSessionComplete(msgs)) break;

  // 超过最大轮次（默认 300 轮）→ 强制中止
  if (assistantTurnCount >= maxTurns) {
    abortSyncSession(client, sessionID, "max_turns_exceeded");
  }
}
// 默认超时：30 分钟
```

### 6.5 Session 连续性（session_id 机制）

每次 `task` 工具调用的返回值末尾都包含：

```
<task_metadata>
session_id: ses_abc123
</task_metadata>
```

Sisyphus 被强制要求保存并复用这个 `session_id`，续接时子 Agent 保留完整上下文，节省约 70% token。

### 6.6 Category 系统

Category 是一套预定义的"任务类型 → 模型配置"映射，供 Sisyphus 按任务特性选择最合适的模型：

```javascript
// 内置 Categories（来自 4 个平台）
BUILTIN_CATEGORIES = [
  ...GOOGLE_CATEGORIES,     // Gemini 系列
  ...OPENAI_CATEGORIES,     // OpenAI 系列
  ...ANTHROPIC_CATEGORIES,  // Claude 系列
  ...KIMI_CATEGORIES        // Kimi 系列
]
```

Category 配置示例结构：
```json
{
  "quick": { "model": "anthropic/claude-haiku-3-5", "description": "Fast, cheap tasks" },
  "build": { "model": "anthropic/claude-sonnet-4-5", "description": "Implementation work" },
  "deep": { "model": "anthropic/claude-opus-4", "description": "Complex reasoning" }
}
```

当 Sisyphus 调用 `task(category="quick", ...)` 时，系统自动将 `subagent_type` 设为 `sisyphus-junior` 并注入对应模型配置。

---

## 七、Hooks 链路详解

### 7.1 tool.execute.before

执行顺序（按 hooks 链依次调用）：

```
bash 命令 null byte 清理
→ writeExistingFileGuard    （防止覆盖已存在文件）
→ questionLabelTruncator    （截断问题标签）
→ claudeCodeHooks           （Claude Code 兼容层）
→ nonInteractiveEnv         （注入非交互环境变量）
→ bashFileReadGuard         （防止 bash 读取文件绕过权限）
→ commentChecker            （检查代码注释质量）
→ ...
```

### 7.2 experimental.chat.messages.transform

`contextInjectorMessagesTransform` 负责在消息列表中注入额外上下文（如项目 README、目录 agents 说明等）。

### 7.3 experimental.session.compacting

会话压缩时：
1. `compactionContextInjector` 捕获并注入当前上下文快照
2. `compactionTodoPreserver` 保留当前 todo 状态（防止压缩后丢失进度）
3. `claudeCodeHooks` 透传给 Claude Code 兼容层

---

## 八、Agent 构建流程（createBuiltinAgents）

```javascript
async function createBuiltinAgents(...) {
  // 1. 获取可用模型列表（连接的 provider）
  const availableModels = await fetchAvailableModels();
  
  // 2. 合并 categories（用户配置 + 内置）
  const mergedCategories = mergeCategories(categories);
  
  // 3. 构建 availableSkills 列表（用于注入 Sisyphus prompt）
  const availableSkills = buildAvailableSkills(discoveredSkills, browserProvider, disabledSkills);
  
  // 4. 构建非 Sisyphus/Hephaestus/Atlas agents（Oracle, Librarian, Explore 等）
  const { pendingAgentConfigs, availableAgents } = collectPendingBuiltinAgents({...});
  
  // 5. 创建 Sisyphus（需要已知 availableAgents 来构建 prompt）
  const sisyphusConfig = maybeCreateSisyphusConfig({
    availableAgents,     // 告知 Sisyphus 可以委派哪些 agent
    availableSkills,     // 告知 Sisyphus 可以加载哪些 skill
    availableCategories, // 告知 Sisyphus 可用的 category
    useTaskSystem,       // 决定用 todo 还是 task 工具
    ...
  });
  
  // 6. 创建 Hephaestus（GPT 系模型专用）
  // 7. 创建 Atlas（图像理解专用）
  return result;  // { sisyphus: config, oracle: config, ... }
}
```

**关键设计**：Sisyphus 的 Prompt 在构建时就已知道所有其他 Agent 的存在，这使得 Prompt 中的委派表格和触发词都是**运行时动态生成**的，会随环境变化（新增 Agent、禁用 Agent）自动更新。

---

## 九、Agent Override（用户自定义覆盖）

用户可在 `oh-my-opencode.json` 中覆盖 Agent 配置：

```json
{
  "agents": {
    "sisyphus": {
      "model": "anthropic/claude-opus-4",
      "prompt_append": "Always respond in Chinese.",
      "category": "deep"
    }
  }
}
```

覆盖应用顺序：
1. `buildAgent(source, model)` — 基础配置
2. `applyCategoryOverride()` — 应用 category 配置（model、temperature 等）
3. `mergeAgentConfig()` — 深度合并用户 override
4. `applyEnvironmentContext()` — 追加环境信息（时区、locale）

`prompt_append` 特殊处理：追加到 prompt 末尾，不替换原有 prompt。  
`file://` 前缀的 prompt：从文件系统读取内容作为 prompt。

---

## 十、工具定义 SDK（`@opencode-ai/plugin`）

```typescript
// 标准工具定义方式
import { tool } from "@opencode-ai/plugin";

const myTool = tool({
  description: "工具描述（LLM 看到的）",
  args: {
    param1: tool.schema.string().describe("参数描述"),
    param2: tool.schema.number().optional(),
  },
  async execute(args, context) {
    // context.sessionID, context.directory, context.worktree
    // context.metadata({ title: "..." })  // 更新 UI
    // context.ask({ permission: "..." })   // 请求权限
    return "结果字符串";
  }
});
```

`tool.schema` 即 zod，所有参数类型通过 zod schema 定义，opencode 主进程负责 JSON Schema 转换和参数验证。

---

## 十一、二次开发关键切入点

### 11.1 添加自定义工具

在 `createToolRegistry` 中注入，或通过 Plugin 的 `tool` hook 返回：

```javascript
// 插件返回格式
return {
  tool: {
    my_custom_tool: tool({
      description: "...",
      args: { input: tool.schema.string() },
      async execute(args, ctx) { return "result"; }
    })
  }
};
```

### 11.2 扩展/修改 Sisyphus Prompt

通过 `agents.sisyphus.prompt_append` 配置追加内容，或通过 `agents.sisyphus.prompt` 全量替换（支持 `file://path` 引用文件）。

也可 fork OMO，在 `buildDynamicSisyphusPrompt` 中添加新的 prompt 模块函数。

### 11.3 添加新 Category

在 `oh-my-opencode.json` 的 `categories` 字段添加自定义分类：

```json
{
  "categories": {
    "my-category": {
      "model": "openai/gpt-4o",
      "description": "My specialized tasks",
      "temperature": 0.3
    }
  }
}
```

### 11.4 拦截工具调用

通过实现 `tool.execute.before` / `tool.execute.after` hook 拦截并修改工具参数/输出。

### 11.5 注册新 Agent

在 `agentSources` 中添加新 agent 工厂函数，或通过 Claude Code 格式的 `.claude/agents/*.md` 文件定义项目级 agent（OMO 会自动加载）。

---

## 十二、架构总结图

```
用户消息
    │
    ▼
opencode 主进程
    │
    ├─ 触发 chat.message hook ──────────────── OMO: 首消息 agent 选择
    │
    ├─ 构建 system prompt
    │   └─ Agent 配置中的 prompt 字段 ──────── Sisyphus 系统 Prompt（动态构建）
    │
    ├─ 调用 LLM（Sisyphus）
    │   └─ LLM 输出工具调用: task(category="build", ...)
    │
    ├─ 触发 tool.execute.before ─────────────── OMO Hooks 链
    │
    ├─ 执行 task 工具（createDelegateTask）
    │   ├─ 解析 category → sisyphus-junior + 模型配置
    │   ├─ 加载 Skills 内容
    │   ├─ 调用 client.session.promptAsync() → 创建子会话
    │   └─ pollSyncSession() → 等待子 agent 完成
    │
    ├─ 触发 tool.execute.after ──────────────── OMO Hooks 链
    │
    └─ 返回结果给 Sisyphus（含 session_id）
```

---

## 十一、本地二次开发指南

### 目录结构

```
opencode-modify/
├── omo-src/                  # OMO 源码（git clone v3.15.3，在此处做修改）
├── .omo-dist-backup/         # 首次 sync 时自动备份的官方原版 dist
├── sync-to-opencode.sh       # 构建 + 同步到 opencode 缓存
└── restore-omo.sh            # 还原官方原版
```

### 关键路径说明

| 路径 | 说明 |
|------|------|
| `omo-src/src/` | 修改这里的 TypeScript 源码 |
| `omo-src/dist/` | 构建产物，opencode 实际加载的是这里 |
| `~/.cache/opencode/packages/oh-my-openagent@latest/node_modules/oh-my-openagent/dist/` | opencode 真正读取的插件目录，sync 脚本负责同步到此处 |

> `node_modules/oh-my-opencode/` 是 npm 安装的包，opencode **不读这里**，与开发流程无关。

### 开发流程

**1. 修改源码**

在 `omo-src/src/` 里改 TypeScript 文件。

**2. 构建并同步（改完后执行）**

```bash
./sync-to-opencode.sh --build
```

首次执行会自动备份官方 `dist/` 到 `.omo-dist-backup/`。

**3. 重启 opencode 生效**

```bash
opencode
```

### 切回官方原版

```bash
./restore-omo.sh
```

从 `.omo-dist-backup/` 还原，无需重新下载，重启 opencode 即生效。

### 注意事项

- `bun run build` 只编译 `dist/`（ESM 模块），不重新编译 native binary
- `oh-my-opencode-darwin-arm64` 是预编译二进制，版本固定，无法在本地修改
- 每次改完源码都要重新跑 `sync-to-opencode.sh --build`，否则 opencode 加载的还是旧 dist

---

## 十三、Custom Agents 配置系统

OMO 支持通过 `~/.opencode/custom-agents.json` 声明式定义自定义 agent 体系，创建与 Sisyphus 平行的独立 orchestrator + subagent 工作流。

### 配置文件格式

```json
{
  "custom_agents": [
    {
      "name": "code-guardian",
      "mode": "primary",
      "description": "Security-focused code orchestrator",
      "model": "anthropic/claude-sonnet-4",
      "system_instructions": "You are Code Guardian, a security-focused engineering lead...",
      "tools": ["bash", "read_file", "write_file", "task"],
      "color": "#FF6B6B",
      "subagents": [
        {
          "name": "security-checker",
          "domain": "Security Analysis",
          "when_to_use": "When code needs security review",
          "default_skills": ["code-audit"]
        }
      ]
    },
    {
      "name": "security-checker",
      "mode": "subagent",
      "description": "Security analysis specialist",
      "model": "anthropic/claude-sonnet-4",
      "system_instructions": "You are a security analysis expert...",
      "tools": ["bash", "read_file", "grep", "glob"]
    }
  ]
}
```

### Agent 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 必填 | kebab-case 唯一标识，不能与内置 agent 重名 |
| `mode` | enum | 必填 | `"primary"` / `"subagent"` / `"all"` |
| `description` | string | 必填 | UI 显示的功能描述 |
| `model` | string | 必填 | `provider/model-id` 格式 |
| `system_instructions` | string | 必填 | 角色与行为描述，注入到 prompt |
| `tools` | string[] | 必填 | 工具白名单，空数组 = 无工具 |
| `color` | string | 可选 | CSS hex 颜色（如 `"#FF6B6B"`） |
| `subagents` | object[] | 可选 | 可委派的 subagent 引用列表 |

### SubagentRef 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 必填 | 引用的 subagent 名称 |
| `domain` | string | 必填 | 负责领域，用于委派表格 |
| `when_to_use` | string | 必填 | 委派触发条件 |
| `default_skills` | string[] | 可选 | 委派时自动注入的 skills |

### 隔离机制

- **Soft Isolation**: Primary 的 prompt 中声明只能委派白名单内的 subagent
- **Hard Isolation**: `task` 工具在运行时校验调用方是否有权委派目标 agent
  - Custom primary 只能委派其 `subagents` 列表中的 agent
  - 内置 agent（如 Sisyphus）不能委派 custom subagent
  - Custom primary 也不能委派内置 subagent（如 sisyphus-junior）

### 校验规则

- Agent name 不能与内置 agent 冲突（大小写不敏感）
- Primary agent 不能被引用为 subagent
- SubagentRef 引用的 agent 必须在配置中存在
- Primary 有 subagents 但 tools 不含 `"task"` 时打印 warning
- 配置文件不存在时静默返回空列表，不影响系统运行

### 实现文件

| 文件 | 职责 |
|------|------|
| `src/agents/custom-agents/config-schema.ts` | Zod schema 定义与交叉校验 |
| `src/agents/custom-agents/config-loader.ts` | 配置文件读取与解析 |
| `src/agents/custom-agents/prompt-builder.ts` | Sisyphus-lite 模板 prompt 生成 |
| `src/agents/custom-agents/agent-factory.ts` | AgentConfig 对象生成 |
| `src/agents/custom-agents/registry.ts` | 注册表，用于 isolation 查询 |
| `src/agents/builtin-agents.ts` | 集成入口，调用 `createCustomAgents()` |
| `src/tools/delegate-task/subagent-resolver.ts` | Hard isolation 校验 |
| `src/tools/delegate-task/tools.ts` | default_skills 注入 |

---

*报告生成时间：2026-04-07*  
*分析源码版本：oh-my-opencode（node_modules 安装版）*  
*开发指南更新：2026-04-08*
