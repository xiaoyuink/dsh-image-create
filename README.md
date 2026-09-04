# @xiaoyuink/dsh-image-create

<p align="center">
  <img src="https://github.com/xiaoyuink/dsh-image-create/raw/main/docs/images/image-generation-studio.png" alt="dsh-image-create 生图工作台" width="800">
  <br>
  <em>🎨 文生图 / 图生图 / 生成历史 / 一体化设置 —— 与 dsh-image-vision 同系列的 DSH 图像插件</em>
</p>

核心思想：**在 DSH 里直接生图，不离开对话**。插件通过宿主进程安全代理 OpenAI 兼容的图像生成接口（`/images/generations` 文生图、`/images/edits` 图生图），在侧边栏提供三栏生图工作台；同时把 `generate_image` 工具注册给 Agent——**在对话框里让模型直接生图，结果自动进入面板历史**。

> **🎯 与视觉插件互补**
>
> [dsh-image-vision](https://github.com/xiaoyuink/dsh-image-vision) 负责「看懂图片」，本插件负责「画出图片」：生图面板的图生图参考图、历史记录里的图片，都能直接配合视觉插件精读。两者设置页 UI 完全一致，配置体验统一。

## 功能总览

- **文生图 / 图生图**：提示词生图，或上传 PNG / JPG / WEBP / GIF 参考图做编辑（编辑模型自动走 `/images/edits`）。
- **Agent 工具**：注册 `generate_image` 工具，对话框里模型可直接生图；生成成功后**自动写入面板历史**。
- **可调参数**：尺寸（预设 + 自定义宽×高，缺省自动补 1024）、清晰度（质量等级 + 自定义 PPI）、生成数量（1–4）、细节等级。
- **编辑模型自动回退**：文生图模式下若选中的是编辑模型（id 含 `edit`），自动改用同供应商的生图模型，不再报 `Missing required key: image`。
- **多供应商 + 自动降级**：配置多个供应商，激活项失败时自动尝试其他供应商。
- **结果操作**：下载、全屏预览（缩放/切换）、复制优化提示词、一键把结果加入图生图。
- **持久化历史**：图片保存在 `~/.dsh/plugin/dsh-image-create/images/`，`index.json` 记录提示词与参数，最多保留 50 条；支持查看、恢复参数、删除、清空；面板历史区显示「图片保存于：实际路径」。
- **在线更新**：检测 GitHub Releases，工作台内一键更新，重启后生效。
- **可视化设置页**：多供应商管理、厂商模板、模型发现、总开关——渲染与视觉插件一致。

## 快速上手（如何使用）

### 安装插件

**方式一：一条命令安装最新 Release（推荐，无需源码/依赖，始终是最新版）**

```bash
dsh plugin --profile web add https://github.com/xiaoyuink/dsh-image-create/releases/latest/download/xiaoyuink-dsh-image-create-latest.tgz
```

> 上面的 URL **永远指向最新版本**（`/releases/latest/` 自动重定向到最新 Release 的资产），无需改版本号。若想安装指定版本，把 `latest` 换成版本号即可，例如：
> `.../releases/download/v1.4.1/xiaoyuink-dsh-image-create-1.4.1.tgz`
>
> 升级更简单：打开 DSH **设置 → 生图插件**，插件会自动检测 GitHub 新版本并**一键更新**，无需手动改 URL 重装。

**方式二：GitHub 仓库开发模式（`link:`，代码改动重启即生效，适合二次开发）**

```bash
# 建议在 ~/.dsh 下新建 plugin 目录，统一存放插件本体
mkdir -p ~/.dsh/plugin
cd ~/.dsh/plugin

# 克隆仓库
git clone https://github.com/xiaoyuink/dsh-image-create.git
cd dsh-image-create
pnpm install
pnpm run build

# 添加到 DSH 配置（link: 协议）
dsh plugin --profile web add "$(pwd)"
```

> **💡 关于插件存放位置**：开发模式建议将插件本体放在 `~/.dsh/plugin/` 目录下统一管理，也可以根据你的喜好放在任意位置，`dsh plugin add` 时指向该路径即可。

安装完成后重启 `dsh web`，然后按以下步骤开始使用：

### 1️⃣ 配置供应商

进入 DSH **设置 → 生图插件**（或「设置 → 插件 → 可配置」卡片），点击 **+ 添加供应商**：

1. 选择**厂商模板**（OpenAI / SiliconFlow / 阿里云 DashScope / 智谱 / 腾讯混元 / 火山引擎 / MiniMax / 阶跃星辰 / 零一万物 / OpenRouter 等），名称与端点自动填入；
2. 填入 **API Key**（建议 `env:VAR` 或 `cred:REF` 引用，见下文「API Key 安全」）；
3. 点击「获取模型列表」自动发现模型，或手动输入模型 ID；
4. 点击模型行的「**使用**」切换为当前激活模型（顶部「当前使用：供应商 · 模型」条实时显示）。

### 2️⃣ 开始生图

**面板方式（推荐）**
```
从 DSH 侧栏打开「生图插件」→ 输入提示词 → 选择尺寸/清晰度/数量 → 点击「开始生成」
```
- **文生图**：直接写提示词生成；
- **图生图**：切到「图生图」标签，点击/拖拽上传参考图（拖拽只进面板、不会误入对话框），再写修改描述。

**Agent 方式**
```
在对话框里对模型说：「帮我生成一张 xxx」
```
模型会自动调用 `generate_image` 工具生图，结果会**同时显示在面板历史记录**中。

### 3️⃣ 管理历史

- 历史列在面板右侧，点击可**查看原图**、**恢复参数**再生成；
- 支持单条删除、清空；图片保存在 `~/.dsh/plugin/dsh-image-create/images/`（历史区顶部会显示实际路径）；
- Agent 在对话框生成的图片同样会出现在这里。

## 一、Agent 工具：`generate_image`

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 详细的图片描述（风格、构图、色彩、光线、主体） |
| `size` | 否 | `auto` / `1024x1024` / `1792x1024` / `1024x1792` / `1536x1024` / `1024x1536`，默认 `auto` |
| `quality` | 否 | `auto` / `low` / `medium` / `high` |
| `n` | 否 | 生成数量（1–4），默认 1 |
| `detail` | 否 | `''`（自动）/ `standard` / `high`（部分网关支持） |
| `image` | 否 | 参考图 data URL，提供后走图生图 |

- 生成成功后自动追加到面板历史记录（与面板生成同一存储）。
- 文生图 + 编辑模型时自动改用同供应商的生图模型。
- 上游失败返回可读错误；多供应商配置下自动降级。

## 二、设置页面（DSH 设置 → 生图插件）

渲染与视觉插件设置页一致（供应商卡片浅灰头部、状态点、就地编辑灰色卡片、框式当前使用条）：

- **总开关**：开启后注册 `generate_image` 工具、Agent 播报与生图工作台；**关闭后主界面「生图插件」面板与侧栏入口消失**，工具与播报注销，对话框如同没有这个插件（设置页保留，可随时重新开启）。
- **当前使用条**：顶部框式显示「当前使用：供应商 · 模型」。
- **多供应商管理**：添加 / 编辑（就地替换） / 删除供应商，每个供应商下多个模型。
- **模型管理**：模型行「使用 / 使用中」切换激活、删除；卡片内「+ 添加模型」就地展开（获取列表勾选 / 手动输入）。
- **厂商模板**：选择后自动填入名称与端点。
- **模型发现**：填端点 + Key 后「获取模型列表」，自动发现该端点全部模型。

## 三、API Key 安全

- 设置页 API Key 为密码框，保存后**不再回显**（`GET /config` 返回 `********` 占位）；**留空保存 = 保留原 Key**。
- 保存明文 Key 时**自动写入 DSH 凭据服务**（`~/.dsh/.credentials.yaml`），`settings.yaml` 只存 `cred:IMAGEGEN_<供应商id>` 引用；凭据服务不可用时**拒绝保存**，绝不落明文。
- 也支持 `env:VAR` 环境变量引用。
- 历史明文 Key 若已写在 `settings.yaml`，重新保存一次该供应商即可自动迁移为 `cred:REF`。

## 四、数据与安全

- 生成请求由 DSH 宿主进程代理，浏览器不直接连接上游 API：不暴露密钥、无 CORS 问题。
- 生成图片与历史索引保存在插件安装目录内：
  - 图片：`~/.dsh/plugin/dsh-image-create/images/`
  - 索引：`~/.dsh/plugin/dsh-image-create/index.json`
- 升级插件（重新 `add` 覆盖目录）前建议备份 `images/` 与 `index.json`。
- 历史跨设备共享：连接同一 DSH 的浏览器/设备看到同一份记录。

## 五、配置数据结构（settings 的 `image-create` 段）

```yaml
image-create:
  enabled: true                     # 总开关
  announceToAgent: true             # 是否向 Agent 播报插件能力
  providers:
    - id: p-1787158417469-sexa      # 供应商唯一 id（自动生成）
      name: SiliconFlow
      apiBaseUrl: https://api.siliconflow.cn/v1
      apiKey: cred:IMAGEGEN_p_xxx   # 凭据引用（明文存于 ~/.dsh/.credentials.yaml）
      models:
        - id: Qwen/Qwen-Image
        - id: Qwen/Qwen-Image-Edit
  active: "p-1787158417469-sexa:Qwen/Qwen-Image"   # 当前激活 "供应商id:模型id"
```

## 六、HTTP 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/POST | `/api/dsh-image-create/config` | 读/写配置（GET 返回脱敏 Key + `saveDir` 图片保存目录） |
| POST | `/api/dsh-image-create/activate` | 切换当前激活的供应商/模型 |
| POST | `/api/dsh-image-create/models` | 模型发现 |
| POST | `/api/dsh-image-create/generate` | 生成代理（文生图 / 图生图） |
| POST | `/api/dsh-image-create/history/list` | 历史列表 |
| POST | `/api/dsh-image-create/history/append` | 追加历史（Agent 工具亦调用） |
| POST | `/api/dsh-image-create/history/remove` | 删除一条历史 |
| POST | `/api/dsh-image-create/history/clear` | 清空历史 |
| GET | `/api/dsh-image-create/history/image/<file>` | 历史图片回读 |
| POST | `/api/dsh-image-create/update/check` | 检查 GitHub Release 更新 |
| POST | `/api/dsh-image-create/update/apply` | 应用更新（重启后生效） |

## 七、接口兼容性

| 场景 | 请求 |
| --- | --- |
| 文生图 | `POST {apiBaseUrl}/images/generations`，JSON 请求体 |
| 图生图 | `POST {apiBaseUrl}/images/edits`，`multipart/form-data`（`image`、`prompt`、`model`、参数） |
| 响应 | 支持 OpenAI 兼容 `{ data: [{ b64_json | url }] }`；URL 图片由宿主下载转 base64 后返回浏览器 |
| 多供应商 | 激活供应商失败自动降级到其他已配置供应商 |

`detail` 与自定义 `ppi` 为透传参数，部分网关支持；官方端点若不接受，引擎会自动去掉 `ppi` 重试。

## 目录结构

```
dsh-image-create/
├── package.json          # 声明 dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # insert 插件行（挂载 bundle）
├── src/
│   ├── index.ts          # host 半：设置注册、generate_image 工具、路由挂载、播报
│   ├── routes.ts         # /api/dsh-image-create/* 路由（配置/生成/历史/更新）
│   ├── engine.ts         # 上游生成代理、多供应商降级、编辑模型回退
│   ├── history-store.ts  # 历史与图片持久化（~/.dsh/plugin/dsh-image-create/）
│   ├── protocol.ts       # 路由路径/类型/厂商模板
│   ├── updater.ts        # GitHub Release 更新
│   └── client/           # 生图工作台、设置页（与视觉插件一致）、侧栏入口
├── docs/images/          # 截图
└── images/               # 运行时：生成图片保存目录（+ index.json 历史索引）
```

## 更新记录

> **给维护者**：发布 Release 时，除 `xiaoyuink-dsh-image-create-<版本>.tgz` 外，请再上传一份固定名资产 `xiaoyuink-dsh-image-create-latest.tgz`（内容相同），保证首页「一条命令安装最新 Release」的 `releases/latest/download/` 链接始终指向最新的包。

- **v1.5.0**：适配 DSH **0.1.2-rc.1** —— `schemastery` 依赖迁移为 `@deepseek-ai/schemastery`；settings 注册改用当前 `SettingsProvider.installSection`（`installSettingsSection`/`settingsNamespace` 已从 dsh-settings 移除）；移除已不存在的 `@deepseek-ai/dsh-client-runtime` 客户端依赖（client bundle 改为外部依赖 react / dsh-client-ui-primitives，与视觉插件同款）；客户端 Context 类型改用 `@deepseek-ai/cordis` 并补齐 renderer / session-controller / conversation 类型声明；`ImageAttachmentRef` 品牌类型适配（attachmentId/mediaType 按当前 dsh-attachment 品牌化）。
- **v1.4.1**：设置页标题行右上角显示当前版本号（小字），检测到 GitHub 新版本时在标题行提示「有新版本」并提供一键更新。
- **v1.4.0**：生成图片持久化到 DSH 附件存储并渲染到消息（markdown 引用 + 图片块，超限自动压缩）；面板预览缩放鼠标锚定重构（消除滚轮缩放晃动）；生成后自动把图片插入对话；在线更新改用 GitHub Release tarball 安装（无需 npm 发布）。
- **v1.3.0**：设置页编辑供应商时「获取模型列表」支持已存密钥自动回查（修复 `cred:REF` 未解析导致 401）；候选模型按关键词标注「生图/非生图」，非生图模型禁选并支持人工纠错（⇄ 按钮翻转判定）；候选列表新增搜索框（不区分大小写）与双级排序（按名称/按是否生图，各可升/降序）；供应商卡片与卡片内模型支持拖拽排序（≡ 手柄，松手自动保存）；预设厂商下拉对已添加厂商置灰标注「已添加」防重复；添加供应商不再自动预填预设模型（须点「获取模型列表」勾选或手动添加）。
- **v1.2.0**：新增阿里云 DashScope 原生文生图接口支持（`qwen-image-3.x` 自动走官方 `multimodal-generation` 接口）；修复凭据保存时 `set` 丢失 `this` 导致 API Key 无法保存的问题；修复设置页切换模型后生图面板模型下拉不同步的问题。
- **v1.1.0**：多供应商与自动降级、模型发现、Agent 工具注册、设置页与视觉插件 UI 对齐、总开关（关闭后面板/工具/播报整体退出）、API Key 存凭据服务（`cred:REF`）、图片保存目录迁入插件安装目录并自动迁移旧数据、自定义尺寸/PPI/数量、编辑模型自动回退、Agent 生图写入面板历史、图生图拖拽不泄漏到对话框、历史区显示图片保存位置。

## 致谢

- **[dsh-image-vision](https://github.com/xiaoyuink/dsh-image-vision)** — 同系列视觉插件；本插件设置页 UI、凭据存储机制与其保持一致，二者配合使用体验统一。

## License

[Apache-2.0](./LICENSE)
