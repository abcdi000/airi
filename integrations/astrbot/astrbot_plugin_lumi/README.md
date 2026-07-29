# astrbot_plugin_lumi

## 群聊只读学习模式

群聊学习由 Lumi 配置，不在插件中维护第二份群白名单：

1. 在桌面 Lumi 的“设置 > AstrBot 接入 > 群聊学习”中添加 AstrBot 实例 ID 和群号。
2. 将运行模式切换为“只读学习”，保存并应用。
3. 插件每 5 秒刷新一次 Lumi 策略，只接收已启用群的文字和图片，不调用回复链路。
4. 文字按 Lumi 配置的批次积累后，由语言整理器归纳表达、黑话和社交行为候选；图片按哈希去重后进入 Lumi 表情包库。

只读学习是一项硬安全约束。该模式下插件不调用回复生成、TTS、MCP 或发送 API；
私聊也会静默暂停。群原文不会进入聊天记录、人物印象、关系状态、日记或长期事实记忆。
退出只读学习并恢复“正常私聊”后，群聊仍不会触发回复，私聊反馈则可以继续影响已经学到的表达。

`astrbot_plugin_lumi` 将 AstrBot 平台收到的有序私聊消息链桥接到同一个 Lumi。它既可以连接中心 Lumi Server，也可以连接正在运行的 Windows 桌面 Lumi。

它不是普通聊天模型 Provider。AstrBot 只负责平台适配、事件、媒体获取和发送；Lumi 负责身份、会话、人格、记忆、视觉、听觉、工具与最终回复。

## 兼容性

- 已按 AstrBot `4.26.7`、commit `2035dbd079375046ce7b82171a04b1f9a63d781a` 开发和源码契约测试。
- `metadata.yaml` 声明支持 AstrBot `>=4.26,<5`。
- Python 要求与 AstrBot 4.26 一致：Python 3.12 或更高版本。
- 插件额外依赖：`httpx>=0.27,<1`。
- Lumi 桌面端或 Server 与插件必须来自包含 AstrBot 感知接口的同一 Lumi 版本。

## 安装

1. 将整个 `astrbot_plugin_lumi` 目录复制到 AstrBot 的 `data/plugins/`，或在 AstrBot WebUI 上传包含该目录内容的 ZIP。
2. 重启 AstrBot，确认插件页出现 `Lumi`。
3. 在插件配置页选择 `本地桌面 Lumi` 或 `中心 Lumi Server`。
4. 填写对应运行时显示的 `lumi_endpoint` 和 `lumi_api_token`。

当前安全策略只处理私聊。身份白名单只在 Lumi 的 AstrBot 接入设置中维护，
插件不保存第二份映射。陌生账号会由 Lumi 拒绝，插件随后静默停止事件，
不会回复，也不会触发 AstrBot 默认 LLM。

## 两种运行方式

### 本地桌面 Lumi

1. 启动 Windows 桌面 Lumi，并保持未登录的离线模式。
2. 在 `设置 > AstrBot 接入` 中启用本地网关。
3. 检查 Doggy/Moussy 的 QQ 身份绑定，点击“保存并应用”。
4. 复制集成令牌。
5. 在 AstrBot 插件中选择 `本地桌面 Lumi`，地址填写
   `http://127.0.0.1:6132`，粘贴令牌并重载插件。
6. 打开插件详情中的“连接测试”页面，确认意识运行时显示为已就绪。

此模式不会创建第二套 Lumi 配置。意识、视觉、听觉、长期记忆、插件和
MCP 全部由桌面端现有的“机体模块”及本地数据提供。QQ 私聊会进入对应
Doggy/Moussy 的本地主时间线。桌面 Lumi 必须保持运行；客户端登录中心
Server 后，本地网关会拒绝请求，防止两套意识同时回复。

本地网关只监听 `127.0.0.1`，不会暴露到局域网。它使用独立集成令牌，
不是 Lumi 在线账号令牌。

### 中心 Lumi Server

在 Lumi Server Manager 的“网络与安全 > AstrBot 接入”中启用感知桥，
填写身份绑定并点击“复制集成令牌”。在 AstrBot 插件中选择
`中心 Lumi Server`，本机默认地址为 `http://127.0.0.1:6130`。

开发目录直接测试：

```powershell
cd integrations\astrbot\astrbot_plugin_lumi
python -m pip install -r requirements.txt
$env:ASTRBOT_SOURCE_ROOT = 'C:\path\to\AstrBot'
python -m unittest discover -s tests -v
```

## 中心 Lumi Server 配置

以下示例把一个 AstrBot QQ 适配器中的两个账号绑定到 Lumi 已有的 Doggy、Moussy 人物。`platformInstanceId` 是 AstrBot 的平台实例 ID，不是展示名称。

```json
{
  "vision": {
    "enabled": true,
    "baseURL": "https://your-provider.example/v1/",
    "apiKey": "replace-me",
    "model": "a-model-that-accepts-images"
  },
  "transcription": {
    "enabled": true,
    "baseURL": "https://your-provider.example/v1/",
    "apiKey": "replace-me",
    "model": "whisper-1",
    "language": "zh"
  },
  "astrbot": {
    "enabled": true,
    "apiToken": "generate-a-random-token-of-at-least-32-characters",
    "identityBindings": [
      {
        "platformInstanceId": "qq-bot-1",
        "externalUserId": "10001",
        "personId": "lumi-user-00000000-0000-4000-8000-000000000001"
      },
      {
        "platformInstanceId": "qq-bot-1",
        "externalUserId": "10002",
        "personId": "lumi-user-00000000-0000-4000-8000-000000000002"
      }
    ]
  }
}
```

不要允许客户端自行提交 Lumi 人物 ID。Lumi Server 只相信服务器配置中的绑定：

- 人物键：`platformInstanceId + externalUserId`。
- 私聊：映射到该人物已有的 `lumi-direct:<personId>` 主时间线，因此同一人物在桌面端和 QQ 上共享 Lumi 私聊记忆。
- 群聊：按 `provider + platformInstanceId + groupId` 隔离；已绑定成员发言时加入该群会话。
- 未绑定用户收到明确拒绝，不会被猜测为 Doggy 或 Moussy。

## 消息流程

```text
AstrBot platform event
  -> routing policy
  -> ordered Plain / Reply / Image / Record parsing
  -> asynchronous media resolution
  -> one LumiPerceptionEvent
  -> selected Lumi runtime identity resolution
  -> Lumi Eyes and Lumi hearing
  -> one ordered perception envelope
  -> Lumi consciousness and memory
  -> one LumiResponse
  -> AstrBot MessageChain
```

`文字 -> 图片 -> 文字 -> 语音` 始终保持这一顺序。图片和语音不会各自生成回复，也不会交给 AstrBot 默认视觉模型或 ASR。

## 接管策略

`trigger_mode` 只控制普通私聊入口：

- `private_always`：默认；处理通过身份校验的私聊。
- `wake_only`：仅处理满足 AstrBot 唤醒规则或额外唤醒词的私聊。
- `mention_only`：仅处理明确 @ 机器人的私聊事件。
- `all_messages`：与 `private_always` 等价；不会扩大到群聊。
- `disabled`：停止桥接。

群聊不受这些选项控制。只有 Lumi 自己进入“只读学习”模式，且群号存在于 Lumi 的学习来源列表时，插件才会把文字和图片提交给只读观察接口。该路径没有回复生成、TTS、工具调用或消息发送能力。

默认忽略 `/` 等命令前缀，并以较低事件优先级运行，让 AstrBot 管理命令和其他命令插件先处理。已停止事件、机器人自身消息，以及“对方正在输入”等不含文字、图片、语音或引用内容的空通知不会再次处理。

Lumi 接管后，插件按 AstrBot 4.26.7 的真实管线调用 `event.should_call_llm(True)` 禁用默认 Agent，然后发送 Lumi 回复并停止后续传播。此 API 名称容易误解：该版本源码把 `call_llm=True` 定义为“禁止默认 LLM”。

## 配置

| 配置 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | `true` | 启用事件桥 |
| `lumi_target` | `desktop_local` | `desktop_local` 或 `server` |
| `lumi_endpoint` | `http://127.0.0.1:6132` | 桌面默认 6132；Server 默认 6130；远程必须 HTTPS |
| `lumi_api_token` | 空 | 从所选 Lumi 运行时复制的独立集成令牌 |
| `speech_endpoint` | `http://127.0.0.1:6132` | 桌面 Lumi 发声网关；中心 Server 模式也保持指向客户端 |
| `speech_api_token` | 空 | 桌面 AstrBot 接入令牌；留空时复用主令牌 |
| `request_timeout_seconds` | `300` | 等待一次 Lumi 完整回复；最低 300 秒 |
| `send_tool_progress` | `true` | 多步工具任务期间发送去重后的 Planner 当前步骤公开首句；不发送工具包装器名称、固定动作/失败话术、隐藏推理、提示词、参数或结果正文；没有公开首句时静默 |
| `connect_timeout_seconds` | `10` | 连接超时 |
| `trigger_mode` | `private_always` | 接管策略 |
| `handle_private_messages` | `true` | 是否处理私聊 |
| `handle_group_mentions` | `false` | 兼容旧配置；当前版本不会启用群聊回复 |
| `wake_words` | `Lumi,lumi` | 私聊入口的额外唤醒词 |
| `ignore_command_messages` | `true` | 命令优先交给其他插件 |
| `command_prefixes` | `/` | 命令前缀 |
| `max_image_bytes` | `10 MiB` | 单张图片上限 |
| `max_audio_bytes` | `25 MiB` | 单条语音上限 |
| `max_audio_duration_seconds` | `300` | 平台提供时长时的上限 |
| `media_download_timeout_seconds` | `30` | 临时媒体下载超时 |
| `ffmpeg_path` | `ffmpeg` | AMR 等非 SILK 音频转 WAV 时使用 |
| `audio_conversion_timeout_seconds` | `60` | 音频转换超时 |
| `temp_file_retention` | `delete` | `delete/keep_on_error/keep` |
| `enable_vision` | `true` | 允许原图进入 Lumi Eyes |
| `enable_hearing` | `true` | 允许原始音频进入 Lumi hearing |
| `prefer_qq_native_transcription` | `true` | SnowLuma 1.12.8+ 或 NapCat 4.18.2+ 优先使用 QQ 原生语音转文字，失败时回退 Lumi hearing |
| `voice_reply_mode` | `all_text` | `all_text/all_voice/random/mirror_input_audio` |
| `random_voice_probability` | `0.35` | 随机模式使用语音的概率，范围 `0..1` |
| `failure_policy` | `friendly_error` | `silent/friendly_error/allow_default_llm_fallback` |
| `allow_default_llm_fallback` | `false` | 失败时是否允许另一人格回复 |

AstrBot 4.26 的 `_conf_schema.json` 没有密码输入类型。Token 使用普通字符串并设置醒目提示；请限制 AstrBot 配置文件权限，不要把配置提交到 Git。

## 图片

支持消息链中的全部 `Image`：

- 已存在的本地路径或 `file://`。
- HTTP/HTTPS 临时 URL。
- `base64://`。
- PNG、JPEG、GIF、WebP。

插件异步下载并校验大小、MIME 与文件魔数，然后只把原始图片字节发送给所选 Lumi 运行时。签名 URL、本地路径和二进制不会写入日志。Lumi 的视觉模型必须支持图片输入；未配置时返回 `vision_unavailable`，不会调用 AstrBot 图片描述模型。

学习群中的图片还可进入 Lumi 自己的表情包库。收藏不依赖视觉模块：Lumi 根据图片哈希去重，并用图片附近文字形成轻量语境标签。私聊回复时，本地 Lumi 按发送概率、冷却间隔、观察次数和当前语境选择表情；AstrBot 使用原生 `Image` 消息组件发送给 SnowLuma/NapCat，桌面聊天窗口同步显示同一张图片。表情包库路径、容量和发送概率只在桌面 Lumi 的“AstrBot 接入”页面配置，插件不维护第二份策略。

## 语音

支持消息链中的全部 `Record`，原始顺序和时长元数据会保留：

- SnowLuma 1.12.8+ 或 NapCat 4.18.2+ 会优先调用 `fetch_ptt_text(message_id)` 使用 QQ 原生转写；成功时不再上传音频给 Lumi hearing。失败日志会保留不含媒体内容和凭据的简短 OneBot 原因。
- QQ 原生转写不可用、失败或返回空文本时，自动回退到下面的 Lumi hearing 音频流程。
- WAV、OGG、WebM、MP3、M4A 直接进入 Lumi hearing。
- QQ/Tencent SILK 使用 AstrBot 4.26 同版本依赖的 `silk-python` 直接解码为 WAV。
- AMR 等其他不受 Lumi 听觉支持的格式集中通过 FFmpeg 尝试转为 WAV。
- FFmpeg 仅在转换非 SILK 格式时才是必需；缺失、超时或转换失败会给出清楚错误。
- QQ/OneBot 未直接提供可用路径时，插件会用原始 `Record.file` 调用 `get_record` 取回 WAV，不使用 AstrBot 默认 ASR。

当前 Lumi hearing 的真实服务端入口是 `LumiVoiceTranscriber`，因此本阶段保留并提交原始音频，但结构化听觉结果目前只有转写；说话人、音量、语速、情绪、环境声与非语言声音尚未实现。未知时长无法可靠执行时长上限，仍会执行字节上限。

QQ/NapCat 可能提供本地文件、临时 URL、AMR 或 SILK；KOOK 常见为可下载 URL 和标准压缩音频。平台临时 URL 必须在过期前可由 AstrBot 主机访问。

Lumi 的回复形式由 `voice_reply_mode` 控制：

- `all_text`：每条回复都发送文本。
- `all_voice`：每条回复都使用桌面 Lumi 当前“机体模块 > 发声”配置合成语音。
- `random`：按 `random_voice_probability` 在文本和语音之间选择。
- `mirror_input_audio`：本次用户消息含语音时使用语音，否则使用文本。

插件会先等待一条 Lumi 回复完整生成，再按 Lumi 的多消息分隔规则拆分；每一条分别请求一次完整 TTS，并分别发送为 QQ 语音。TTS 失败时保留 Lumi 已生成的文字回复，不会改用 AstrBot 的另一人格。

选择中心 Server 时，意识请求走 `lumi_endpoint`，语音合成仍走
`speech_endpoint` 指向的桌面客户端。此时必须让桌面 Lumi 保持运行，并在
`speech_api_token` 填写桌面“AstrBot 接入”页的令牌。在线客户端只开放本机
TTS，不会同时启动一套离线意识。

## 临时文件与隐私

- 临时文件位于 AstrBot 的 `plugin_data/astrbot_plugin_lumi/temporary_media`。
- 默认在请求结束后删除；失败保留可通过配置控制。
- HTTP 下载使用连接池、超时、流式大小检查。
- 日志只记录事件 ID 和错误类别，不记录正文、token、媒体字节或 URL 查询参数。
- 插件提交给 Lumi 运行时的媒体段会移除平台签名 URL 和 AstrBot 本机路径。

## 管理命令

仅 AstrBot 管理员可用：

- `/lumi_status`：插件开关、端点、接管策略、视觉/听觉开关。
- `/lumi_health`：运行时可达性及视觉、听觉能力。
- `/lumi_reload`：重建客户端并重新读取当前插件配置。

命令不会显示 token。

插件详情中的“连接测试”页面提供同样的可视化检查，并额外显示当前目标、
端点和令牌是否已填写。页面只接收布尔令牌状态，不会取得令牌内容。

## 常见错误

- `identity_unbound`：在桌面 Lumi 的“AstrBot 接入”或 Server Manager 中绑定平台实例和账号。
- 群聊不会触发 Lumi 回复；只读学习模式仅记录 Lumi 明确授权群的文字和图片，并且不受唤醒词或 @ 影响。
- Lumi 用空行或 `LUMI_NEXT_REPLY` 分隔的多条回复会按顺序分别发送到平台，不会只保留第一条。
- QQ 文字、图片和语音转写在桌面聊天窗口按用户可读形式显示；模型使用的视觉/听觉结构化感知不会显示成 JSON。
- `Authentication required`：插件 token 与当前桌面/Server 集成令牌不一致，或 token 少于 32 字符。
- `vision_unavailable`：桌面模式检查“机体模块 > 视觉”；Server 模式检查 `vision`。
- `hearing_unavailable`：桌面模式检查“机体模块 > 听觉”；Server 模式检查 `transcription`。
- `silk-python is required`：在 AstrBot 插件管理中重新安装或重载插件依赖。
- `FFmpeg is required`：仅影响 AMR 等其他格式；配置 `ffmpeg_path`，或让平台提供 Lumi hearing 可直接接收的格式。
- `Lumi runtime is unavailable`：检查目标、地址、端口，以及桌面 Lumi 或 Server 是否正在运行。
- `runtime_mode_conflict`：桌面 Lumi 当前登录了中心 Server；注销并回到离线模式，或把插件目标改为 `server`。
- `runtime_not_ready`：桌面窗口尚未加载完成，或“机体模块 > 意识”没有保存可用的服务商和模型。
- 群消息不回复：这是强制安全策略；学习群也只观察，不发送。
- 出现双回复：确认 AstrBot 版本处于支持范围，并运行源码契约测试检查 `call_llm` 语义。

## 当前限制

- 尚未实现 Lumi 主动向 AstrBot 会话推送消息。
- 已支持用桌面 Lumi 发声模块生成 QQ 语音回复，并支持本地 Lumi 表情包作为图片消息输出；通用图片生成和文件输出仍未实现。
- 尚未实现跨平台账号自助绑定；绑定只能由 Lumi Server 管理员配置。
- 语音的完整听觉特征仍缺失，目前 Server 只做转写。
- 未知平台私有媒体对象若既无本地路径、URL、`file` 或 base64，将明确失败；没有调用不稳定的适配器私有方法。

## AstrBot 工具桥下一阶段

AstrBot 4.26.7 的公开 `Context.get_llm_tool_manager()` 能枚举注册工具，也提供启用/禁用接口；实际通用执行仍依赖 Agent Runner 内部的 `FunctionToolExecutor` 和事件上下文。本阶段没有导入这些私有 Core 执行类。

下一阶段应在 AstrBot 提供稳定公开调用接口后实现 `LumiToolGateway`：

1. 把允许暴露的 AstrBot/MCP 工具投影为 Lumi Server 工具描述。
2. Lumi 意识决定调用后，经带事件身份和会话权限的网关回到 AstrBot。
3. 工具结果返回同一次 Lumi 意识循环，AstrBot 不生成最终自然语言。
4. 加入工具白名单、超时、审计、幂等和主动消息能力。
