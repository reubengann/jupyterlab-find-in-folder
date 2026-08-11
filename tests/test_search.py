from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import nbformat
import pytest
import jupyterlab_find_in_folder.search as search_module

from jupyterlab_find_in_folder.search import (
    SearchEngine,
    SearchError,
    SearchManager,
    SearchOptions,
    parse_rg_match,
    resolve_scope,
    search_notebook,
    _compile_notebook_pattern,
)


def options(**overrides) -> SearchOptions:
    values = {
        "query": "needle",
        "jobId": "test-job",
        "scope": "",
        "batchSize": 10,
    }
    values.update(overrides)
    return SearchOptions.from_json(values)


def test_resolve_scope_stays_beneath_root(tmp_path: Path) -> None:
    child = tmp_path / "child"
    child.mkdir()
    assert resolve_scope(tmp_path, "child") == child
    with pytest.raises(SearchError, match="inside"):
        resolve_scope(tmp_path, "../outside")
    with pytest.raises(SearchError, match="existing"):
        resolve_scope(tmp_path, "missing")


def test_options_require_safe_job_id() -> None:
    with pytest.raises(SearchError, match="jobId"):
        SearchOptions.from_json({"query": "x", "jobId": "../bad"})


@pytest.mark.asyncio
async def test_manager_cancels_only_the_requested_job() -> None:
    manager = SearchManager()
    first = manager.start("first")
    second = manager.start("second")
    assert await manager.cancel("first") is True
    assert first.cancelled.is_set()
    assert not second.cancelled.is_set()
    manager.finish("first")
    manager.finish("second")
    assert await manager.cancel("missing") is False


def test_parse_rg_match_converts_utf8_byte_offsets() -> None:
    text = "α needle here\n"
    start = len("α ".encode())
    payload = {
        "type": "match",
        "data": {
            "path": {"text": "unicode.py"},
            "lines": {"text": text},
            "line_number": 4,
            "submatches": [{"start": start, "end": start + len(b"needle")}],
        },
    }
    matches = parse_rg_match(payload, "src", 1_000)
    assert matches == [
        {
            "path": "src/unicode.py",
            "kind": "file",
            "line": 3,
            "column": 2,
            "endColumn": 8,
            "preview": "α needle here",
        }
    ]


def test_notebook_search_only_uses_source_cells(tmp_path: Path) -> None:
    path = tmp_path / "sample.ipynb"
    notebook = nbformat.v4.new_notebook(
        cells=[
            nbformat.v4.new_code_cell(
                "needle = 1",
                outputs=[
                    nbformat.v4.new_output("stream", text="needle in output")
                ],
            ),
            nbformat.v4.new_markdown_cell("Another NEEDLE"),
        ],
        metadata={"needle": "not a result"},
    )
    nbformat.write(notebook, path)
    search_options = options()
    matches = search_notebook(
        path,
        "sample.ipynb",
        _compile_notebook_pattern(search_options),
        search_options,
    )
    assert [(item["cellIndex"], item["line"]) for item in matches] == [(0, 0), (1, 0)]
    assert all(item["kind"] == "notebook" for item in matches)


@pytest.mark.asyncio
async def test_engine_streams_files_and_notebook_sources(tmp_path: Path) -> None:
    (tmp_path / "plain.txt").write_text("a needle here\n", encoding="utf-8")
    notebook = nbformat.v4.new_notebook(
        cells=[nbformat.v4.new_code_cell("needle = 2")]
    )
    nbformat.write(notebook, tmp_path / "sample.ipynb")

    events = [
        event
        async for event in SearchEngine(tmp_path).events(
            options(maxMatches=100, maxFiles=10)
        )
    ]
    matches = [
        match
        for event in events
        if event["type"] == "matches"
        for match in event["matches"]
    ]
    assert {match["kind"] for match in matches} == {"file", "notebook"}
    assert events[-1]["type"] == "done"
    assert events[-1]["matchCount"] == 2


@pytest.mark.asyncio
async def test_plain_file_batch_is_flushed_before_notebook_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "plain.txt").write_text("needle\n", encoding="utf-8")
    nbformat.write(
        nbformat.v4.new_notebook(
            cells=[nbformat.v4.new_code_cell("no match here")]
        ),
        tmp_path / "slow.ipynb",
    )
    release_notebook = threading.Event()

    def blocked_notebook_search(*args, **kwargs):
        release_notebook.wait(timeout=5)
        return []

    monkeypatch.setattr(search_module, "search_notebook", blocked_notebook_search)
    events = SearchEngine(tmp_path).events(options())
    first = await asyncio.wait_for(anext(events), timeout=2)
    assert first["type"] == "matches"
    assert first["matches"][0]["path"] == "plain.txt"

    release_notebook.set()
    remaining = [event async for event in events]
    assert remaining[-1]["type"] == "done"


@pytest.mark.asyncio
async def test_engine_reports_global_match_limit(tmp_path: Path) -> None:
    (tmp_path / "many.txt").write_text("needle\nneedle\n", encoding="utf-8")
    events = [
        event
        async for event in SearchEngine(tmp_path).events(options(maxMatches=1))
    ]
    assert events[-1]["truncated"] is True
    assert events[-1]["reason"] == "match limit reached"
    assert events[-1]["matchCount"] == 1
