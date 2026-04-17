"""Realtime dialogue RAG flow aligned with demo: ChatTTSText(500) + ChatRAGText(502)."""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from contextlib import suppress
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Optional

if TYPE_CHECKING:
    from app.volc_realtime import VolcRealtimeClient

LOGGER = logging.getLogger("doubao.realtime")


GraphResultMode = str


@dataclass
class GraphRAGResult:
    """Graph 输出契约：既可返回证据，也可返回最终答复。"""

    mode: GraphResultMode
    content: str
    meta: dict[str, Any] | None = None


def _normalize_graph_result(raw: Any) -> GraphRAGResult:
    """
    Normalize query_agent output to GraphRAGResult.
    Backward compatible with legacy plain-string result (treated as evidence).
    """
    if isinstance(raw, GraphRAGResult):
        return raw
    if isinstance(raw, str):
        return GraphRAGResult(mode="evidence", content=raw)
    if isinstance(raw, dict):
        mode = str(raw.get("mode", "empty")).strip().lower() or "empty"
        content = str(raw.get("content", "")).strip()
        meta = raw.get("meta")
        if not isinstance(meta, dict):
            meta = None
        if mode not in ("evidence", "final_answer", "empty"):
            LOGGER.warning("invalid graph result mode=%s, fallback to empty", mode)
            mode = "empty"
        return GraphRAGResult(mode=mode, content=content, meta=meta)
    return GraphRAGResult(mode="empty", content="")


def build_external_rag_payload(user_query: str, agent_text: str) -> str:
    """Serialize external RAG for event 502 using demo-compatible single evidence block."""
    _ = user_query  # keep signature stable for callers
    blocks: list[dict[str, str]] = [
        {"title": "检索结果", "content": (agent_text or "").strip() or "（暂无可用检索结论）"},
    ]
    return json.dumps(blocks, ensure_ascii=False)


def _sanitize_for_tts(text: str) -> str:
    """Strip orchestration/meta wording before sending to TTS."""
    raw = (text or "").strip()
    if not raw:
        return ""
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw).strip()
    markers = (
        "conversation_id",
        "dialog_context",
        "latest_user_query",
        "mode",
        "meta",
        "助理agent",
        "外部rag",
        "工具调用",
        "内部上下文",
        "请返回严格 json",
    )
    lines: list[str] = []
    for line in raw.splitlines():
        item = line.strip()
        if not item:
            continue
        lower_item = item.lower()
        if any(m in lower_item for m in markers):
            continue
        item = re.sub(r"^(结论|回答|最终答复|关键证据|证据|说明)\s*[:：]\s*", "", item)
        if item:
            lines.append(item)
    cleaned = " ".join(lines).strip()
    return cleaned or raw


def pick_random_comfort_line() -> str:
    pool = [
        "我先帮你查一下更准确的信息，请稍等。",
        "正在为你检索相关资料，马上回来。",
        "感谢等待，我正在整理结果给你。",
        "我在快速核对信息，马上告诉你。",
        "已收到，我正在为你查询，请稍等片刻。",
        "我先确认一下细节，很快回复你。",
    ]
    return random.choice(pool)


async def send_comfort_chat_tts_text(client: VolcRealtimeClient, content: str) -> None:
    """Match demo: start segment then end segment (empty content on end)."""
    await client.send_chat_tts_text(start=True, end=False, content=content)
    await client.send_chat_tts_text(start=False, end=True, content="")


async def run_graph_upstream_pipeline(
    *,
    client: VolcRealtimeClient,
    conversation_id: str,
    user_query: str,
    dialog_context: list[dict[str, Any]],
    query_agent: Callable[..., Awaitable[Any]],
    build_fallback_final_query: Callable[[str], str],
    log_prefix: str = "[RAGFlow]",
    after_comfort: Optional[Callable[[], Awaitable[None]]] = None,
) -> GraphRAGResult:
    """
    Protocol sequence: start Agent task -> 500 (comfort TTS) -> optional after_comfort hook
    -> await Agent -> branch by GraphResult mode:
       - evidence: 502 (external_rag)
       - final_answer: send final query directly
       - empty: fallback final query

    `after_comfort` lets callers (e.g. WebSocket turn state) switch to "answering" before 502 TTS
    so streamed assistant text (event 550) is not dropped.
    Returns normalized GraphRAGResult for caller-side logging/context persistence.
    """
    helper_task = asyncio.create_task(
        query_agent(
            conversation_id=conversation_id,
            user_query=user_query,
            dialog_context=dialog_context,
        )
    )
    try:
        comfort = pick_random_comfort_line()
        LOGGER.info("%s comfort (500): conversation_id=%s line=%s", log_prefix, conversation_id, comfort)
        await send_comfort_chat_tts_text(client, comfort)

        if after_comfort is not None:
            await after_comfort()

        result = _normalize_graph_result(await helper_task)
        result.content = _sanitize_for_tts(result.content)

        if result.mode == "evidence":
            evidence = result.content or "当前检索暂未取得有效结论，请换个问法或补充关键信息。"
            payload = build_external_rag_payload(user_query, evidence)
            LOGGER.info(
                "%s ChatRAGText(502): conversation_id=%s preview=%s",
                log_prefix,
                conversation_id,
                payload[:200],
            )
            try:
                await client.send_chat_rag_text(payload)
            except Exception as exc:
                LOGGER.warning("%s send_chat_rag_text(502) failed: %s", log_prefix, exc)
                raise
            return GraphRAGResult(mode="evidence", content=evidence, meta=result.meta)

        if result.mode == "final_answer":
            final_query = _sanitize_for_tts(result.content) or build_fallback_final_query(user_query)
            LOGGER.info(
                "%s direct_final_query: conversation_id=%s preview=%s",
                log_prefix,
                conversation_id,
                final_query[:200],
            )
            await client.send_chat_text_query(final_query)
            return GraphRAGResult(mode="final_answer", content=result.content, meta=result.meta)

        fallback_query = build_fallback_final_query(user_query)
        LOGGER.info(
            "%s empty_graph_result -> fallback_final_query: conversation_id=%s preview=%s",
            log_prefix,
            conversation_id,
            fallback_query[:200],
        )
        await client.send_chat_text_query(fallback_query)
        return GraphRAGResult(mode="empty", content="", meta=result.meta)
    except BaseException:
        if not helper_task.done():
            helper_task.cancel()
            with suppress(asyncio.CancelledError):
                await helper_task
        raise
