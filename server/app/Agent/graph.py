"""LangGraph Agent (MCP driven).

This module:
1) Removes previous hard-coded tools (SQL/Python/Fig/Human).
2) Integrates remote Model Context Protocol (MCP) servers configured in `server/config.yaml`.
3) Builds a single tool `mcp_call` that can invoke any discovered MCP tool.
"""

from __future__ import annotations

import io
import json
import logging
import os
import re
import traceback
import urllib.request
import uuid
from contextlib import redirect_stdout
from datetime import datetime
from pathlib import Path
from typing import Annotated, Any, Dict, Optional, TypedDict

from dotenv import load_dotenv
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from langgraph.runtime import Runtime
from langgraph.types import interrupt
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
if logger.level == logging.NOTSET:
    logger.setLevel(logging.INFO)
if not logger.handlers:
    _h = logging.StreamHandler()
    _h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
    logger.addHandler(_h)
logger.propagate = True


# --------------------------------------------
# .env loading (best effort)
# --------------------------------------------
_STUDIO_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
_ROOT_ENV_PATH = Path(__file__).resolve().parents[3] / ".env"
for p in (_STUDIO_ENV_PATH, _ROOT_ENV_PATH):
    try:
        load_dotenv(p, override=False)
    except Exception:
        pass


# --------------------------------------------
# App-visible public URLs (images/exports)
# --------------------------------------------
_PUBLIC_BASE_URL = os.getenv("AGENT_PUBLIC_BASE_URL", "http://localhost:8000/static").rstrip("/")
_SERVER_STATIC_DIR = Path(__file__).resolve().parents[2] / "static"
_IMAGES_DIR = _SERVER_STATIC_DIR / "images"
_EXPORTS_DIR = _SERVER_STATIC_DIR / "exports"

_IMAGES_DIR.mkdir(parents=True, exist_ok=True)
_EXPORTS_DIR.mkdir(parents=True, exist_ok=True)


# --------------------------------------------
# Graph state / context
# --------------------------------------------
class Context(TypedDict, total=False):
    """Runtime context parameters for the agent."""

    my_configurable_param: str


class AgentState(TypedDict):
    """Graph state."""

    messages: Annotated[list[BaseMessage], add_messages]


# In-memory datastore for extracted DataFrames
_DATASTORE: dict[str, Any] = {}


# --------------------------------------------
# Tools
# --------------------------------------------
class SQLQuerySchema(BaseModel):
    """Schema for SQL query execution."""

    sql_query: str = Field(description="用于 MySQL 查询的 SQL 语句。")


@tool(args_schema=SQLQuerySchema)
def sql_inter(sql_query: str) -> str:
    """执行 MySQL 查询并返回 JSON 字符串结果（只允许只读语句）。"""
    try:
        import pymysql
    except Exception:
        return "执行失败：缺少依赖 pymysql，请先安装。"

    host = os.getenv("MYSQL_HOST", "127.0.0.1")
    port = int(os.getenv("MYSQL_PORT", "3306"))
    user = os.getenv("MYSQL_USER", "root")
    password = os.getenv("MYSQL_PASSWORD", "")
    database = os.getenv("MYSQL_DATABASE", "")

    if not database:
        return "执行失败：未设置 MYSQL_DATABASE 环境变量。"

    sql = (sql_query or "").strip().rstrip(";")
    if not sql:
        return "执行失败：sql_query 不能为空。"

    lowered = sql.lower()
    if not lowered.startswith(("select", "show", "desc", "explain", "with")):
        return "安全限制：sql_inter 仅允许 SELECT/SHOW/DESC/EXPLAIN/WITH 查询语句。"

    conn = None
    try:
        conn = pymysql.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database=database,
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
            connect_timeout=10,
            read_timeout=30,
            write_timeout=30,
        )
        with conn.cursor() as cursor:
            cursor.execute(sql)
            rows = cursor.fetchall()

        max_rows = 200
        clipped = rows[:max_rows]
        payload = {
            "row_count": len(rows),
            "returned_count": len(clipped),
            "truncated": len(rows) > max_rows,
            "rows": clipped,
        }
        return json.dumps(payload, ensure_ascii=False)
    except Exception as e:
        return f"执行失败：{type(e).__name__}: {e}"
    finally:
        if conn is not None:
            conn.close()


class ExtractQuerySchema(BaseModel):
    """Schema for data extraction from MySQL."""

    sql_query: str = Field(description="用于从 MySQL 提取数据的 SQL 查询语句。")
    df_name: str = Field(description="保存结果的 pandas 变量名。")


@tool(args_schema=ExtractQuerySchema)
def extract_data(sql_query: str, df_name: str) -> str:
    """提取 MySQL 查询结果并保存为 DataFrame 变量，并导出到 CSV。"""
    try:
        import pandas as pd
        import pymysql
    except Exception:
        return "执行失败：缺少依赖 pymysql/pandas，请先安装。"

    safe_name = (df_name or "").strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", safe_name):
        return "执行失败：df_name 必须是合法 Python 变量名。"

    sql = (sql_query or "").strip().rstrip(";")
    if not sql:
        return "执行失败：sql_query 不能为空。"
    if not sql.lower().startswith(("select", "show", "desc", "explain", "with")):
        return "安全限制：extract_data 仅允许 SELECT/SHOW/DESC/EXPLAIN/WITH 查询语句。"

    host = os.getenv("MYSQL_HOST", "127.0.0.1")
    port = int(os.getenv("MYSQL_PORT", "3306"))
    user = os.getenv("MYSQL_USER", "root")
    password = os.getenv("MYSQL_PASSWORD", "")
    database = os.getenv("MYSQL_DATABASE", "")

    if not database:
        return "执行失败：未设置 MYSQL_DATABASE 环境变量。"

    conn = None
    try:
        conn = pymysql.connect(
            host=host,
            port=port,
            user=user,
            password=password,
            database=database,
            charset="utf8mb4",
            cursorclass=pymysql.cursors.DictCursor,
            connect_timeout=10,
            read_timeout=30,
            write_timeout=30,
        )
        with conn.cursor() as cursor:
            cursor.execute(sql)
            rows = cursor.fetchall()
        df = pd.DataFrame(rows)

        _DATASTORE[safe_name] = df
        globals()[safe_name] = df

        csv_path = _EXPORTS_DIR / f"{safe_name}.csv"
        df.to_csv(csv_path, index=False, encoding="utf-8-sig")
        csv_url = f"{_PUBLIC_BASE_URL}/exports/{csv_path.name}"

        return (
            f"提取成功：DataFrame 已保存为 `{safe_name}`，形状={df.shape}，列={list(df.columns)}\n"
            f"导出文件：{csv_path}\n"
            f"下载链接：{csv_url}"
        )
    except Exception as e:
        return f"执行失败：{type(e).__name__}: {e}"
    finally:
        if conn is not None:
            conn.close()


class PythonCodeInput(BaseModel):
    """Schema for general Python code execution."""

    py_code: str = Field(description="一段合法的 Python 代码字符串，用于计算/数据处理。")


@tool(args_schema=PythonCodeInput)
def python_inter(py_code: str) -> str:
    """执行非绘图类 Python 代码并返回 stdout/变量摘要。"""
    code = (py_code or "").strip()
    if not code:
        return "执行失败：py_code 不能为空。"

    banned = ["import subprocess", "__import__", "open(", "eval(", "exec("]
    if any(x in code for x in banned):
        return "安全限制：代码包含高风险语句，请改为纯计算/数据处理代码。"

    try:
        import math

        import numpy as np
        import pandas as pd
    except Exception:
        return "执行失败：缺少依赖 pandas/numpy，请先安装。"

    safe_globals: dict[str, Any] = {"pd": pd, "np": np, "math": math, "json": json, **_DATASTORE}
    local_vars: dict[str, Any] = {}
    buf = io.StringIO()
    try:
        with redirect_stdout(buf):
            exec(code, safe_globals, local_vars)
        stdout_text = buf.getvalue().strip()
        visible = {k: type(v).__name__ for k, v in local_vars.items() if not k.startswith("_")}

        # 同步写回 datastore，允许后续 fig_inter / python_inter 直接用变量
        for k, v in local_vars.items():
            if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) and not k.startswith("_"):
                _DATASTORE[k] = v
        return json.dumps({"stdout": stdout_text, "locals": visible}, ensure_ascii=False)
    except NameError as e:
        available = sorted(list(_DATASTORE.keys()))
        return (
            f"执行失败：{type(e).__name__}: {e}\n"
            f"当前可用 DataFrame: {available}\n"
            "建议：先调用 extract_data(sql_query, df_name) 生成目标变量，再调用 python_inter。"
        )
    except Exception:
        return "执行失败：\n" + traceback.format_exc(limit=2)


class FigCodeInput(BaseModel):
    """Schema for plotting code execution."""

    py_code: str = Field(description="要执行的 Python 绘图代码。")
    fname: str = Field(description="图片文件名，例如 trend.png")


@tool(args_schema=FigCodeInput)
def fig_inter(py_code: str, fname: str) -> str:
    """执行绘图代码并将图片保存到 server/static/images 目录。"""
    code = (py_code or "").strip()
    if not code:
        return "执行失败：py_code 不能为空。"

    safe_name = (fname or "").strip() or f"fig_{uuid.uuid4().hex[:8]}.png"
    if "/" in safe_name or "\\" in safe_name:
        return "执行失败：fname 不能包含路径分隔符。"
    if not safe_name.lower().endswith((".png", ".jpg", ".jpeg", ".svg")):
        safe_name += ".png"

    try:
        import matplotlib
        import matplotlib.pyplot as plt
        import numpy as np
        import pandas as pd
        import seaborn as sns
    except Exception:
        return "执行失败：缺少依赖 matplotlib/seaborn/pandas/numpy，请先安装。"

    output_path = _IMAGES_DIR / safe_name

    current_backend = matplotlib.get_backend()
    matplotlib.use("Agg")

    # 中文字体处理：优先使用自定义字体路径，其次系统字体；找不到也不阻断绘图
    try:
        chosen_font = None
        import matplotlib.font_manager as font_manager

        env_font_path = os.getenv("CHINESE_FONT_PATH", "").strip()
        candidate_files = []
        if env_font_path:
            candidate_files.append(env_font_path)

        candidate_files.extend(
            [
                "/System/Library/Fonts/PingFang.ttc",
                "/System/Library/Fonts/STHeiti Light.ttc",
                "/System/Library/Fonts/Hiragino Sans GB.ttc",
                "/Library/Fonts/Arial Unicode.ttf",
                "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
                "/usr/share/fonts/truetype/arphic/ukai.ttc",
            ]
        )

        project_font = Path(__file__).resolve().parents[2] / "static" / "fonts" / "NotoSansSC-Regular.otf"
        candidate_files.append(str(project_font))

        chosen_file = next((p for p in candidate_files if p and os.path.isfile(p)), None)
        if chosen_file is None:
            # 本地没有中文字体时，尝试下载一份 Noto CJK（失败不阻断）
            try:
                project_font.parent.mkdir(parents=True, exist_ok=True)
                urllib.request.urlretrieve(
                    "https://raw.githubusercontent.com/googlefonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf",
                    str(project_font),
                )
                if project_font.is_file():
                    chosen_file = str(project_font)
            except Exception:
                pass

        if chosen_file is not None:
            font_manager.fontManager.addfont(chosen_file)
            chosen_font = font_manager.FontProperties(fname=chosen_file)
            family = chosen_font.get_name()
            plt.rcParams["font.family"] = family
            plt.rcParams["font.sans-serif"] = [family]
    except Exception:
        chosen_font = None

    plt.rcParams["axes.unicode_minus"] = False

    safe_globals: dict[str, Any] = {"plt": plt, "pd": pd, "sns": sns, "np": np, **_DATASTORE}
    local_vars: dict[str, Any] = {}
    try:
        exec(code, safe_globals, local_vars)

        fignums = plt.get_fignums()
        if not fignums:
            return (
                "绘图失败：未检测到生成的 matplotlib figure（可能代码内部已 close 图）。"
                "请确保绘图代码中确实调用了 matplotlib/seaborn 生成图。"
            )

        last_fig = plt.figure(fignums[-1])

        if chosen_font is not None:
            for ax in last_fig.axes:
                try:
                    ax.title.set_fontproperties(chosen_font)
                    ax.xaxis.label.set_fontproperties(chosen_font)
                    ax.yaxis.label.set_fontproperties(chosen_font)
                    for tick in ax.get_xticklabels() + ax.get_yticklabels():
                        tick.set_fontproperties(chosen_font)
                    legend = ax.get_legend()
                    if legend is not None:
                        for text in legend.get_texts():
                            text.set_fontproperties(chosen_font)
                except Exception:
                    pass

        if last_fig.axes:
            try:
                last_fig.tight_layout()
            except Exception:
                pass

        last_fig.savefig(output_path, dpi=160, bbox_inches="tight")
        plt.close("all")

        public_image_url = f"{_PUBLIC_BASE_URL}/images/{safe_name}"
        return (
            f"绘图成功：{safe_name}\n"
            f"访问地址：{public_image_url}\n"
            f"Markdown: ![图表]({public_image_url})"
        )
    except FileNotFoundError as e:
        return "绘图失败：文件不存在：{0}".format(e)
    except NameError as e:
        available = sorted(list(_DATASTORE.keys()))
        return (
            f"绘图失败：{type(e).__name__}: {e}\n"
            f"当前可用 DataFrame: {available}\n"
            "建议：先调用 extract_data(sql_query, df_name='product_df')，再在绘图代码中使用对应变量。"
        )
    except Exception:
        return "绘图失败：\n" + traceback.format_exc(limit=2)
    finally:
        try:
            matplotlib.use(current_backend)
        except Exception:
            pass


@tool
def human_assistance(query: str) -> str:
    """请求人工协助，暂停图执行并等待人工回复。"""
    q = (query or "").strip() or "请提供下一步执行建议。"
    human_response = interrupt({"query": q})
    if isinstance(human_response, dict):
        return str(human_response.get("data") or human_response)
    return str(human_response)


# --------------------------------------------
# MCP integration (remote tools)
# --------------------------------------------
MCP_SERVER_SPECS: dict[str, dict[str, Any]] = {}
MCP_TOOL_CONTEXT: dict[str, list[dict[str, Any]]] = {}
MCP_INITED: bool = False


def _normalize_mcp_tools(raw: Any) -> list[dict[str, Any]]:
    tools = getattr(raw, "tools", raw)
    if not isinstance(tools, list):
        return []
    out: list[dict[str, Any]] = []
    for t in tools:
        if isinstance(t, dict):
            name = t.get("name")
            desc = t.get("description") or ""
            input_schema = t.get("inputSchema") or t.get("input_schema") or {}
        else:
            name = getattr(t, "name", None)
            desc = getattr(t, "description", "") or ""
            input_schema = getattr(t, "inputSchema", None) or getattr(t, "input_schema", None) or {}
        if not name:
            continue
        out.append({"name": name, "description": str(desc), "inputSchema": input_schema})
    return out


async def _list_mcp_tools(server_url: str, timeout_seconds: int) -> list[dict[str, Any]]:
    """Best-effort: try streamable_http then SSE."""
    from mcp import ClientSession

    last_exc: Optional[Exception] = None

    # 1) streamable http
    try:
        from mcp.client.streamable_http import streamablehttp_client
        logger.info("[MCP] listing tools via streamable_http: url=%s timeout=%s", server_url, timeout_seconds)

        try:
            cm = streamablehttp_client(server_url, timeout=timeout_seconds)
        except TypeError:
            cm = streamablehttp_client(server_url)

        async with cm as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                tools_raw = await session.list_tools()
                logger.info("[MCP] list_tools success via streamable_http: url=%s", server_url)
                return _normalize_mcp_tools(tools_raw)
    except Exception as e:
        last_exc = e

    # 2) SSE
    try:
        from mcp.client.sse import sse_client
        logger.info("[MCP] fallback list_tools via sse: url=%s timeout=%s", server_url, timeout_seconds)

        try:
            cm = sse_client(server_url, timeout=timeout_seconds)
        except TypeError:
            cm = sse_client(server_url)

        async with cm as streams:
            async with ClientSession(*streams) as session:
                await session.initialize()
                tools_raw = await session.list_tools()
                logger.info("[MCP] list_tools success via sse: url=%s", server_url)
                return _normalize_mcp_tools(tools_raw)
    except Exception as e:
        last_exc = e

    assert last_exc is not None
    raise last_exc


async def _call_mcp_tool(server_url: str, tool_name: str, arguments: dict[str, Any], timeout_seconds: int) -> str:
    """Best-effort: try streamable_http then SSE."""
    from mcp import ClientSession

    last_exc: Optional[Exception] = None

    # 1) streamable http
    try:
        from mcp.client.streamable_http import streamablehttp_client
        logger.info(
            "[MCP] calling tool: url=%s tool=%s timeout=%s args=%s",
            server_url,
            tool_name,
            timeout_seconds,
            json.dumps(arguments or {}, ensure_ascii=False)[:500],
        )

        try:
            cm = streamablehttp_client(server_url, timeout=timeout_seconds)
        except TypeError:
            cm = streamablehttp_client(server_url)

        async with cm as (read, write, _):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.call_tool(tool_name, arguments)
                logger.info("[MCP] tool call success: url=%s tool=%s", server_url, tool_name)

                payload = getattr(result, "content", result)
                try:
                    return json.dumps(payload, ensure_ascii=False, default=str)
                except Exception:
                    return str(payload)
    except Exception as e:
        last_exc = e

    assert last_exc is not None
    raise last_exc


class McpCallSchema(BaseModel):
    """Generic MCP call schema."""

    server_name: str = Field(description="yaml 中 mcp.<server_name> 的 key，例如 amap。")
    tool_name: str = Field(description="MCP 工具名。")
    arguments: dict[str, Any] = Field(default_factory=dict, description="传入 MCP 工具的参数(JSON对象)。")


@tool(args_schema=McpCallSchema)
async def mcp_call(server_name: str, tool_name: str, arguments: dict[str, Any]) -> str:
    """Call an MCP tool by server/tool name, return tool result as JSON string."""
    spec = MCP_SERVER_SPECS.get(server_name)
    logger.info(
        "[Agent] mcp_call requested: server=%s tool=%s args=%s",
        server_name,
        tool_name,
        json.dumps(arguments or {}, ensure_ascii=False)[:500],
    )
    if not spec:
        logger.warning("[Agent] mcp_call server not found: server=%s", server_name)
        return f"MCP 调用失败：未找到 server_name={server_name}（是否已在 config.yaml 配置并启用？）"

    url = str(spec.get("url", "")).strip()
    timeout_seconds = int(spec.get("timeout_seconds", 15))
    if not url:
        logger.warning("[Agent] mcp_call url empty: server=%s", server_name)
        return f"MCP 调用失败：server_name={server_name} 的 url 为空。"

    try:
        result = await _call_mcp_tool(url, tool_name, arguments or {}, timeout_seconds=timeout_seconds)
        logger.info(
            "[Agent] mcp_call finished: server=%s tool=%s result_preview=%s",
            server_name,
            tool_name,
            str(result)[:300],
        )
        return result
    except Exception as e:
        logger.exception("[Agent] mcp_call failed: server=%s tool=%s err=%s", server_name, tool_name, type(e).__name__)
        return f"MCP 调用失败：{type(e).__name__}: {e}"


def _format_mcp_tools_for_prompt(max_servers: int = 6, max_tools_per_server: int = 25, max_chars: int = 3000) -> str:
    if not MCP_TOOL_CONTEXT:
        return "（当前未发现任何 MCP 工具；请等待系统初始化或检查网络/鉴权配置。）"

    servers = list(MCP_TOOL_CONTEXT.items())[:max_servers]
    lines: list[str] = []
    for server_name, tools in servers:
        lines.append(f"- {server_name}: {len(tools)} tools")
        for t in (tools or [])[:max_tools_per_server]:
            tool_desc = str(t.get("description") or "").strip().replace("\n", " ")
            lines.append(f"  - {t.get('name')}: {tool_desc}")
            # 只在描述里保留 inputSchema 的精简信息，避免把 prompt 顶爆
            input_schema = t.get("inputSchema")
            if input_schema:
                try:
                    compact = json.dumps(input_schema, ensure_ascii=False, default=str)
                    compact = compact[:220] + ("..." if len(compact) > 220 else "")
                    lines.append(f"    inputSchema: {compact}")
                except Exception:
                    pass

    text = "\n".join(lines)
    if len(text) > max_chars:
        return text[:max_chars] + "..."
    return text


async def init_mcp_servers(mcp_cfg: Optional[dict[str, Any]]) -> None:
    """Initialize all MCP servers configured in `server/config.yaml` (best-effort)."""
    global MCP_SERVER_SPECS, MCP_TOOL_CONTEXT, MCP_INITED
    MCP_SERVER_SPECS = {}
    MCP_TOOL_CONTEXT = {}
    MCP_INITED = False

    mcp_cfg = mcp_cfg or {}
    logger.info("[MCP] init start: configured_keys=%s", list(mcp_cfg.keys()) if isinstance(mcp_cfg, dict) else [])
    if not isinstance(mcp_cfg, dict) or not mcp_cfg:
        MCP_INITED = True
        return

    try:
        import mcp  # noqa: F401
    except Exception as e:
        logger.warning("[MCP] missing python dependency `mcp`: %s", type(e).__name__)
        MCP_INITED = True
        return

    for server_name, spec in mcp_cfg.items():
        if not isinstance(spec, dict):
            continue
        if not spec.get("enabled", False):
            logger.info("[MCP] skip disabled server: %s", server_name)
            continue

        url = str(spec.get("url", "")).strip()
        timeout_seconds = int(spec.get("timeout_seconds", 15))
        if not url:
            logger.warning("[MCP] %s enabled but url is empty.", server_name)
            continue

        MCP_SERVER_SPECS[server_name] = {"url": url, "timeout_seconds": timeout_seconds}

        # Discover tools for prompt and tool routing.
        try:
            MCP_TOOL_CONTEXT[server_name] = await _list_mcp_tools(url, timeout_seconds=timeout_seconds)
            logger.info("[MCP] %s tools loaded: %d", server_name, len(MCP_TOOL_CONTEXT[server_name]))
        except Exception as e:
            MCP_TOOL_CONTEXT[server_name] = []
            logger.warning("[MCP] %s tool discovery failed: %s", server_name, type(e).__name__)

    MCP_INITED = True
    logger.info("[MCP] init done: active_servers=%s", list(MCP_SERVER_SPECS.keys()))


def build_tools() -> list[Any]:
    """Build tool list."""
    # Strictly only expose MCP tool (remove hard-coded local tools).
    return [mcp_call]


tools = build_tools()


async def agent_node(state: AgentState, runtime: Runtime[Context]) -> Dict[str, Any]:
    """Agent node: call LLM with bound tools, then either stop or continue in ToolNode."""
    configured_param = (runtime.context or {}).get("my_configurable_param")

    messages = state.get("messages") or []
    if not messages:
        messages = [HumanMessage(content="请先说明你的数据分析目标。")]
    logger.info("[Agent] agent_node start: messages=%d", len(messages))

    llm_messages_time = datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
    tool_message_count = sum(1 for m in messages if isinstance(m, ToolMessage))

    # 选择模型：按参考代码优先走 BAILIAN dashscope compatible
    # 也允许直接用 OPENAI_API_KEY
    bailing_key = os.getenv("BAILIAN_API_KEY") or os.getenv("DASHSCOPE_API_KEY")
    openai_key = os.getenv("AGENT_OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY")

    if not bailing_key and not openai_key:
        content = "[Agent] 未配置 `BAILIAN_API_KEY` 或 `OPENAI_API_KEY`，无法调用模型。"
        if configured_param:
            content += f"(Configured with {configured_param})"
        return {"messages": [AIMessage(content=content)]}

    try:
        from langchain_openai import ChatOpenAI
    except Exception as e:
        content = f"[Agent] 缺少依赖 `langchain-openai`: {type(e).__name__}: {e}"
        return {"messages": [AIMessage(content=content)]}

    temperature = 0
    if bailing_key:
        qwen_model = os.getenv("QWEN_MODEL", "qwen-flash")
        base_url = os.getenv("BAILIAN_BASE_URL", "https://dashscope.aliyuncs.com/compatible-mode/v1")
        llm = ChatOpenAI(
            model=qwen_model,
            api_key=bailing_key,
            base_url=base_url,
            temperature=temperature,
            streaming=False,
        )
    else:
        # OpenAI 直连
        openai_model = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        llm = ChatOpenAI(
            model=openai_model,
            api_key=openai_key,
            temperature=temperature,
            streaming=False,
        )

    llm_with_tools = llm.bind_tools(tools)

    system_prompt = (
        f"当前本地时间：{llm_messages_time}。"
        "你是“天府长岛元创岛智能体”的助理 Agent。"
        "你的上游调用方是天府长岛元创岛智能体，它会向你发起查询并使用你的结果。"
        "你必须始终围绕“天府长岛”相关内容作答（如园区介绍、位置交通、产业方向、配套服务、入驻政策、活动资讯等）。"
        "若问题与天府长岛无关，必须明确说明“该问题不在天府长岛咨询范围内”，并请对方改问园区相关问题。"
        "你只能通过 MCP 工具获取外部信息/执行能力，禁止编造任何数据、来源、计算结果或外部文件路径。"
        "如果没有足够证据，明确说“当前无足够依据”。"
        "可用 MCP 工具如下：\n"
        f"{_format_mcp_tools_for_prompt()}\n"
        "当需要调用外部能力时，必须只调用工具 `mcp_call`，并提供："
        "server_name（yaml 中 mcp.<server_name> 的 key）、tool_name（MCP 工具名）、arguments（JSON 对象）。"
        "工具返回会作为证据；最终回答必须基于证据，并在需要时原样引用关键返回片段/URL。"
        "如果工具返回了图片 URL，请在最终回答中使用 Markdown：`![图表](<url>)`。"
        "你最多进行 8 次工具调用；达到上限后必须基于已有工具结果直接给出结论，禁止继续调用工具。"
    )

    model_input = [SystemMessage(content=system_prompt), *messages]
    force_finalize = tool_message_count >= 8
    if force_finalize:
        model_input.insert(
            1,
            SystemMessage(
                content="你已经获得足够工具结果。现在直接给最终答案，禁止继续工具调用。"
            ),
        )

    # 可观测性：LangSmith 等是可选项；失败不阻断
    try:
        if os.getenv("LANGSMITH_API_KEY"):
            import langsmith

            project_name = os.getenv("LANGSMITH_PROJECT", "langgraphtour")
            os.environ.setdefault("LANGSMITH_TRACING_V2", "true")
            client = langsmith.Client()
            with langsmith.tracing_context(client=client, project_name=project_name, enabled=True):
                ai_message = await (llm.ainvoke(model_input) if force_finalize else llm_with_tools.ainvoke(model_input))
        else:
            ai_message = await (llm.ainvoke(model_input) if force_finalize else llm_with_tools.ainvoke(model_input))
    except Exception:
        ai_message = await (llm.ainvoke(model_input) if force_finalize else llm_with_tools.ainvoke(model_input))

    tool_calls = getattr(ai_message, "tool_calls", None)
    if tool_calls:
        logger.info("[Agent] model requested tool calls: count=%d", len(tool_calls))
        return {"messages": [ai_message]}

    content = getattr(ai_message, "content", "") or ""
    if configured_param and content:
        content += f"\n(Configured with {configured_param})"
    logger.info("[Agent] model returned final content without tool call: preview=%s", str(content)[:200])
    return {"messages": [ai_message]}


# --------------------------------------------
# Graph assembly
# --------------------------------------------
agent_graph = (
    StateGraph(AgentState, context_schema=Context)
    .add_node("agent", agent_node)
    .add_node("tools", ToolNode(tools))
    .add_edge(START, "agent")
    .add_conditional_edges("agent", tools_condition, {"tools": "tools", "__end__": END})
    .add_edge("tools", "agent")
    .compile(name="Agent ToolNode Graph")
)


# 兼容默认模板入口（`from app.Agent.graph import graph`）
graph = agent_graph


async def run_agent(
    content: str,
    conversation_messages: Optional[list[BaseMessage]] = None,
    my_configurable_param: Optional[str] = None,
) -> list[BaseMessage]:
    """Convenience wrapper for API usage."""
    if not content or not content.strip():
        return conversation_messages or []

    messages = list(conversation_messages or [])
    messages.append(HumanMessage(content=content.strip()))
    logger.info(
        "[Agent] run_agent invoked: history=%d, appended_human_len=%d",
        len(conversation_messages or []),
        len(content.strip()),
    )

    recursion_limit = int(os.getenv("AGENT_RECURSION_LIMIT", "80"))
    config: dict[str, Any] = {"recursion_limit": recursion_limit}
    if my_configurable_param:
        config["configurable"] = {"my_configurable_param": my_configurable_param}

    # LangGraph compiled graph returns the full state; we only care about messages
    state = await graph.ainvoke({"messages": messages}, config=config)
    logger.info("[Agent] run_agent finished: output_messages=%d", len(state.get("messages") or []))
    return state.get("messages") or []

