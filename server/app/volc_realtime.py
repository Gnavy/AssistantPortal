import json
import struct
import uuid
from typing import Any

import websockets


class VolcRealtimeClient:
    """
    豆包实时语音的轻量封装：
    - 与火山引擎 WebSocket 建连（服务端鉴权）
    - 发送 StartConnection / StartSession / TaskRequest / FinishSession
    - 把上游返回的消息透传给调用方
    """

    EVENT_START_CONNECTION = 1
    EVENT_FINISH_CONNECTION = 2
    EVENT_START_SESSION = 100
    EVENT_FINISH_SESSION = 102
    EVENT_TASK_REQUEST = 200
    # ChatTTSText / ChatRAGText（与 demo/realtime_dialog_client.py 一致）
    EVENT_CHAT_TTS_TEXT = 500
    EVENT_CHAT_TEXT_QUERY = 501
    EVENT_CHAT_RAG_TEXT = 502
    EVENT_CLIENT_INTERRUPT = 515

    MSG_TYPE_FULL_CLIENT_REQUEST = 0b0001
    MSG_TYPE_AUDIO_ONLY_REQUEST = 0b0010
    MSG_TYPE_FULL_SERVER_RESPONSE = 0b1001
    MSG_TYPE_AUDIO_ONLY_RESPONSE = 0b1011
    MSG_TYPE_ERROR = 0b1111

    SERIALIZATION_RAW = 0b0000
    SERIALIZATION_JSON = 0b0001
    COMPRESSION_NONE = 0b0000

    FLAG_WITH_EVENT = 0b0100

    CONNECTION_EVENTS = {1, 2, 50, 51, 52}

    def __init__(
        self,
        ws_url: str,
        app_id: str,
        access_key: str,
        app_key: str,
        resource_id: str,
        bot_name: str,
        sample_rate: int = 16000,
        model_version: str = "1.2.1.1",
    ) -> None:
        self.ws_url = ws_url
        self.headers = {
            "X-Api-App-ID": app_id,
            "X-Api-Access-Key": access_key,
            "X-Api-App-Key": app_key,
            "X-Api-Resource-Id": resource_id,
        }
        self.bot_name = bot_name
        self.sample_rate = sample_rate
        self.model_version = model_version
        self._conn: websockets.ClientConnection | None = None
        self._session_id = str(uuid.uuid4())

    async def connect(self) -> None:
        self._conn = await websockets.connect(self.ws_url, additional_headers=self.headers)
        await self._send_event(self.EVENT_START_CONNECTION, {})

    async def start_session(self, session_config: dict[str, Any] | None = None) -> None:
        payload = {
            "dialog": {
                "bot_name": self.bot_name,
                "extra": {
                    # 文档要求 StartSession 必传模型版本。
                    "model": self.model_version,
                },
            },
            "asr": {
                "audio_info": {
                    "format": "pcm",
                    "sample_rate": self.sample_rate,
                    "bits": 16,
                    "channel": 1,
                }
            },
        }
        if session_config:
            payload = self._deep_merge(payload, session_config)
        await self._send_event(self.EVENT_START_SESSION, payload, is_session_event=True)

    async def send_audio_chunk(self, chunk: bytes) -> None:
        if not self._conn:
            raise RuntimeError("Upstream websocket is not connected.")
        frame = self._build_frame(
            message_type=self.MSG_TYPE_AUDIO_ONLY_REQUEST,
            flags=self.FLAG_WITH_EVENT,
            serialization=self.SERIALIZATION_RAW,
            compression=self.COMPRESSION_NONE,
            event=self.EVENT_TASK_REQUEST,
            payload_bytes=chunk,
            include_session_id=True,
        )
        await self._conn.send(frame)

    async def send_keep_alive(self) -> None:
        await self._send_event(
            self.EVENT_TASK_REQUEST,
            {"dialog": {"extra": {"input_mod": "keep_alive"}}},
            is_session_event=True,
        )

    async def recv(self) -> str | bytes:
        if not self._conn:
            raise RuntimeError("Upstream websocket is not connected.")
        message = await self._conn.recv()
        if isinstance(message, str):
            # 理论上 realtime v3 主要走二进制，兜底透传文本。
            return message
        return self._decode_server_frame(message)

    async def finish_session(self) -> None:
        await self._send_event(self.EVENT_FINISH_SESSION, {}, is_session_event=True)

    async def send_client_interrupt(self) -> None:
        # 文档：麦克风按键输入模式下支持 ClientInterrupt(515) 打断服务端响应。
        await self._send_event(self.EVENT_CLIENT_INTERRUPT, {}, is_session_event=True)

    async def send_chat_text_query(self, content: str) -> None:
        await self._send_event(
            self.EVENT_CHAT_TEXT_QUERY,
            {"content": content},
            is_session_event=True,
        )

    async def send_chat_tts_text(self, *, start: bool, end: bool, content: str) -> None:
        """ChatTTSText：安抚话术等，由 TTS 播报，不等同于用户 text_query。"""
        await self._send_event(
            self.EVENT_CHAT_TTS_TEXT,
            {"start": start, "end": end, "content": content},
            is_session_event=True,
        )

    async def send_chat_rag_text(self, external_rag: str) -> None:
        """ChatRAGText：注入外部 RAG 数据（JSON 字符串，格式见 demo）。"""
        await self._send_event(
            self.EVENT_CHAT_RAG_TEXT,
            {"external_rag": external_rag},
            is_session_event=True,
        )

    async def close(self) -> None:
        if not self._conn:
            return
        try:
            await self._send_event(self.EVENT_FINISH_CONNECTION, {})
        finally:
            await self._conn.close()
            self._conn = None

    async def _send_event(self, event: int, payload: dict[str, Any], is_session_event: bool = False) -> None:
        if not self._conn:
            raise RuntimeError("Upstream websocket is not connected.")
        payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        frame = self._build_frame(
            message_type=self.MSG_TYPE_FULL_CLIENT_REQUEST,
            flags=self.FLAG_WITH_EVENT,
            serialization=self.SERIALIZATION_JSON,
            compression=self.COMPRESSION_NONE,
            event=event,
            payload_bytes=payload_bytes,
            include_session_id=is_session_event and event not in self.CONNECTION_EVENTS,
        )
        await self._conn.send(frame)

    def _build_frame(
        self,
        message_type: int,
        flags: int,
        serialization: int,
        compression: int,
        event: int,
        payload_bytes: bytes,
        include_session_id: bool,
    ) -> bytes:
        header = bytes(
            [
                (0b0001 << 4) | 0b0001,  # version=1, header_size=4 bytes
                ((message_type & 0x0F) << 4) | (flags & 0x0F),
                ((serialization & 0x0F) << 4) | (compression & 0x0F),
                0x00,
            ]
        )
        optional = struct.pack(">I", event)
        if include_session_id:
            sid = self._session_id.encode("utf-8")
            optional += struct.pack(">I", len(sid)) + sid
        return header + optional + struct.pack(">I", len(payload_bytes)) + payload_bytes

    def _decode_server_frame(self, frame: bytes) -> str | bytes:
        if len(frame) < 8:
            return frame

        byte1 = frame[1]
        byte2 = frame[2]
        message_type = (byte1 >> 4) & 0x0F
        flags = byte1 & 0x0F
        serialization = (byte2 >> 4) & 0x0F

        offset = 4
        event: int | None = None
        session_id: str | None = None

        if flags == self.FLAG_WITH_EVENT:
            event = struct.unpack(">I", frame[offset : offset + 4])[0]
            offset += 4

            if event not in self.CONNECTION_EVENTS:
                session_id_size = struct.unpack(">I", frame[offset : offset + 4])[0]
                offset += 4
                session_id = frame[offset : offset + session_id_size].decode("utf-8", errors="ignore")
                offset += session_id_size

        payload_size = struct.unpack(">I", frame[offset : offset + 4])[0]
        offset += 4
        payload = frame[offset : offset + payload_size]

        if message_type == self.MSG_TYPE_AUDIO_ONLY_RESPONSE:
            return payload

        if message_type == self.MSG_TYPE_ERROR:
            if serialization == self.SERIALIZATION_JSON:
                try:
                    data = json.loads(payload.decode("utf-8"))
                except Exception:
                    data = {"error": payload.decode("utf-8", errors="ignore")}
            else:
                data = {"error": payload.decode("utf-8", errors="ignore")}
            if event is not None:
                data["event"] = event
            if session_id:
                data["session_id"] = session_id
            return json.dumps(data, ensure_ascii=False)

        if serialization == self.SERIALIZATION_JSON:
            try:
                data = json.loads(payload.decode("utf-8"))
            except Exception:
                data = {"raw": payload.decode("utf-8", errors="ignore")}
            if event is not None:
                data["event"] = event
            if session_id:
                data["session_id"] = session_id
            return json.dumps(data, ensure_ascii=False)

        return payload

    def _deep_merge(self, base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
        out = dict(base)
        for k, v in override.items():
            if isinstance(v, dict) and isinstance(out.get(k), dict):
                out[k] = self._deep_merge(out[k], v)
            else:
                out[k] = v
        return out
