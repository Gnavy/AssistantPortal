# Doubao Realtime Voice Demo (FastAPI)

基于 FastAPI 的豆包实时语音交互示例，包含：

- 服务端 WebSocket 代理（隐藏火山鉴权密钥）
- 浏览器麦克风采集 + 实时音频上行 demo
- 浏览器文字输入（ChatTextQuery）+ 语音播报回复
- 实时显示上游返回消息

## 1. 安装

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 2. 配置 YAML

```bash
vi config.yaml
```

编辑 `config.yaml`，至少填写：

- `volc.app_id`
- `volc.access_key`

默认配置中已包含：

- 实时语音连接地址 `volc.ws_url`
- 固定参数 `volc.app_key`、`volc.resource_id`
- 模型版本 `volc.model_version`
- 身份设定 `session.dialog.system_role`
- TTS 播放格式 `session.tts.audio_config`（`pcm_s16le@24000`）
- 对话历史配置 `context.enabled`、`context.max_rounds`
- MCP 配置 `mcp.amap.*`，可把高德 MCP 结果注入豆包回答

## 3. 启动服务

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

打开 [http://localhost:8000](http://localhost:8000)。

## 4. 协议说明

按照火山引擎豆包实时语音文档，示例里使用了：

- `wss://openspeech.bytedance.com/api/v3/realtime/dialogue`
- 鉴权 Header:
  - `X-Api-App-ID`
  - `X-Api-Access-Key`
  - `X-Api-App-Key`
  - `X-Api-Resource-Id`
- 事件：
  - `StartConnection(1)`
  - `StartSession(100)`
  - `TaskRequest(200)`
  - `FinishSession(102)`
  - `FinishConnection(2)`

> 注意：官方文档中的二进制帧结构可能会随协议版本更新。若你当前账号启用了严格二进制协议模式，可在 `app/volc_realtime.py` 中替换为官方最新帧编解码实现。
