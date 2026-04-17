"""LangGraph driven Agent package.

This package exposes a compiled LangGraph `graph` via lazy import.
"""

from __future__ import annotations

__all__ = ["graph"]


def __getattr__(name: str):
    if name == "graph":
        from .graph import graph as _graph

        return _graph
    raise AttributeError(name)

