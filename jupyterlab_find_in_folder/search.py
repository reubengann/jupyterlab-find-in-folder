from __future__ import annotations

import asyncio
import fnmatch
import json
import os
import re
import shutil
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, AsyncIterator, Iterable


DEFAULT_EXCLUDES = ("**/.ipynb_checkpoints/**",)
BATCH_FLUSH_SECONDS = 0.05


class SearchError(ValueError):
    """A user-facing search validation error."""


@dataclass(frozen=True)
class SearchOptions:
    query: str
    scope: str = ""
    job_id: str = ""
    regex: bool = False
    case_sensitive: bool = False
    whole_word: bool = False
    includes: tuple[str, ...] = ()
    excludes: tuple[str, ...] = DEFAULT_EXCLUDES
    max_matches: int = 10_000
    max_files: int = 2_000
    max_matches_per_file: int = 500
    max_output_bytes: int = 20_000_000
    max_line_length: int = 20_000
    timeout_seconds: float = 30.0
    batch_size: int = 100

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "SearchOptions":
        query = value.get("query")
        if not isinstance(query, str) or not query:
            raise SearchError("query must be a non-empty string")
        job_id = value.get("jobId")
        if not isinstance(job_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", job_id):
            raise SearchError("jobId must contain only letters, numbers, '_' or '-'")

        def strings(name: str, default: Iterable[str] = ()) -> tuple[str, ...]:
            raw = value.get(name, list(default))
            if not isinstance(raw, list) or not all(isinstance(item, str) for item in raw):
                raise SearchError(f"{name} must be an array of strings")
            return tuple(item for item in raw if item)

        def bounded_int(name: str, default: int, low: int, high: int) -> int:
            raw = value.get(name, default)
            if not isinstance(raw, int) or isinstance(raw, bool):
                raise SearchError(f"{name} must be an integer")
            return max(low, min(high, raw))

        def bounded_float(name: str, default: float, low: float, high: float) -> float:
            raw = value.get(name, default)
            if not isinstance(raw, (int, float)) or isinstance(raw, bool):
                raise SearchError(f"{name} must be a number")
            return max(low, min(high, float(raw)))

        scope = value.get("scope", "")
        if not isinstance(scope, str):
            raise SearchError("scope must be a string")
        excludes = strings("excludes", DEFAULT_EXCLUDES)
        if "**/.ipynb_checkpoints/**" not in excludes:
            excludes += ("**/.ipynb_checkpoints/**",)
        return cls(
            query=query,
            scope=scope,
            job_id=job_id,
            regex=bool(value.get("regex", False)),
            case_sensitive=bool(value.get("caseSensitive", False)),
            whole_word=bool(value.get("wholeWord", False)),
            includes=strings("includes"),
            excludes=excludes,
            max_matches=bounded_int("maxMatches", 10_000, 1, 50_000),
            max_files=bounded_int("maxFiles", 2_000, 1, 10_000),
            max_matches_per_file=bounded_int(
                "maxMatchesPerFile", 500, 1, 5_000
            ),
            max_output_bytes=bounded_int(
                "maxOutputBytes", 20_000_000, 100_000, 100_000_000
            ),
            max_line_length=bounded_int("maxLineLength", 20_000, 200, 100_000),
            timeout_seconds=bounded_float("timeoutSeconds", 30.0, 1.0, 300.0),
            batch_size=bounded_int("batchSize", 100, 10, 500),
        )


def resolve_scope(root_dir: str | os.PathLike[str], scope: str) -> Path:
    """Resolve a Jupyter-relative folder without allowing root escape."""
    root = Path(root_dir).resolve()
    normalized = scope.replace("\\", "/").strip("/")
    if ":" in PurePosixPath(normalized).parts[:1]:
        raise SearchError("drive-qualified scopes are not supported")
    candidate = (root / Path(*PurePosixPath(normalized).parts)).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise SearchError("scope must remain inside the Jupyter root") from error
    if not candidate.is_dir():
        raise SearchError("scope is not an existing folder")
    return candidate


def _char_offset(text: str, byte_offset: int) -> int:
    encoded = text.encode("utf-8")
    return len(encoded[:byte_offset].decode("utf-8", errors="ignore"))


def parse_rg_match(
    payload: dict[str, Any], scope: str, max_line_length: int
) -> list[dict[str, Any]]:
    data = payload.get("data", {})
    path_data = data.get("path", {})
    line_data = data.get("lines", {})
    relative = path_data.get("text")
    text = line_data.get("text")
    if not isinstance(relative, str) or not isinstance(text, str):
        return []
    text = text.rstrip("\r\n")
    if len(text) > max_line_length:
        text = text[:max_line_length] + "…"
    path = str(PurePosixPath(scope, relative.replace("\\", "/")))
    line = max(0, int(data.get("line_number", 1)) - 1)
    matches: list[dict[str, Any]] = []
    for submatch in data.get("submatches", []):
        start = submatch.get("start")
        end = submatch.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            continue
        column = _char_offset(line_data.get("text", ""), start)
        end_column = _char_offset(line_data.get("text", ""), end)
        matches.append(
            {
                "path": path,
                "kind": "file",
                "line": line,
                "column": column,
                "endColumn": end_column,
                "preview": text,
            }
        )
    return matches


def _matches_globs(path: str, includes: tuple[str, ...], excludes: tuple[str, ...]) -> bool:
    normalized = path.replace("\\", "/")
    if any(fnmatch.fnmatch(normalized, pattern) for pattern in excludes):
        return False
    return not includes or any(fnmatch.fnmatch(normalized, pattern) for pattern in includes)


def _compile_notebook_pattern(options: SearchOptions) -> re.Pattern[str]:
    expression = options.query if options.regex else re.escape(options.query)
    if options.whole_word:
        expression = rf"(?<!\w)(?:{expression})(?!\w)"
    flags = 0 if options.case_sensitive else re.IGNORECASE
    try:
        return re.compile(expression, flags)
    except re.error as error:
        raise SearchError(f"Invalid regular expression: {error}") from error


def search_notebook(
    notebook_path: Path,
    display_path: str,
    pattern: re.Pattern[str],
    options: SearchOptions,
) -> list[dict[str, Any]]:
    import nbformat

    try:
        notebook = nbformat.read(notebook_path, as_version=4)
    except Exception:
        return []
    results: list[dict[str, Any]] = []
    for cell_index, cell in enumerate(notebook.cells):
        if cell.get("cell_type") not in {"code", "markdown"}:
            continue
        cell_id = cell.get("id")
        for line_index, line in enumerate(str(cell.get("source", "")).splitlines()):
            preview = line
            if len(preview) > options.max_line_length:
                preview = preview[: options.max_line_length] + "…"
            for found in pattern.finditer(line):
                results.append(
                    {
                        "path": display_path,
                        "kind": "notebook",
                        "line": line_index,
                        "column": found.start(),
                        "endColumn": found.end(),
                        "preview": preview,
                        "cellIndex": cell_index,
                        "cellId": cell_id,
                        "cellType": cell.get("cell_type"),
                    }
                )
                if len(results) >= options.max_matches_per_file:
                    return results
    return results


class StreamingProcess:
    """A subprocess with async line reads that also works on Windows Tornado loops."""

    def __init__(
        self,
        process: subprocess.Popen[bytes],
        loop: asyncio.AbstractEventLoop,
    ) -> None:
        self._process = process
        self._loop = loop
        self._lines: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._stderr = bytearray()
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    @classmethod
    async def start(
        cls, command: list[str], cwd: Path
    ) -> "StreamingProcess":
        creationflags = (
            subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
        )
        process = await asyncio.to_thread(
            subprocess.Popen,
            command,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            creationflags=creationflags,
        )
        return cls(process, asyncio.get_running_loop())

    @property
    def returncode(self) -> int | None:
        return self._process.poll()

    @property
    def stderr(self) -> str:
        return self._stderr.decode("utf-8", errors="replace")

    async def readline(self) -> bytes:
        line = await self._lines.get()
        return b"" if line is None else line

    def terminate(self) -> None:
        if self.returncode is None:
            self._process.terminate()

    def kill(self) -> None:
        if self.returncode is None:
            self._process.kill()

    async def wait(self) -> int:
        return await asyncio.to_thread(self._process.wait)

    def _pump_stdout(self) -> None:
        assert self._process.stdout is not None
        try:
            for line in iter(self._process.stdout.readline, b""):
                self._call_soon(self._lines.put_nowait, line)
        finally:
            self._call_soon(self._lines.put_nowait, None)

    def _drain_stderr(self) -> None:
        assert self._process.stderr is not None
        for chunk in iter(lambda: self._process.stderr.read(4096), b""):
            if len(self._stderr) < 65_536:
                self._stderr.extend(chunk[: 65_536 - len(self._stderr)])

    def _call_soon(self, callback, *args) -> None:
        try:
            self._loop.call_soon_threadsafe(callback, *args)
        except RuntimeError:
            # The loop can close during interpreter/server shutdown.
            pass


@dataclass
class SearchJob:
    job_id: str
    process: StreamingProcess | None = None
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)

    async def cancel(self) -> None:
        self.cancelled.set()
        process = self.process
        if process is not None and process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=2)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()


class SearchManager:
    def __init__(self) -> None:
        self._jobs: dict[str, SearchJob] = {}

    def start(self, job_id: str) -> SearchJob:
        if job_id in self._jobs:
            raise SearchError("jobId is already active")
        job = SearchJob(job_id)
        self._jobs[job_id] = job
        return job

    async def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if job is None:
            return False
        await job.cancel()
        return True

    def finish(self, job_id: str) -> None:
        self._jobs.pop(job_id, None)


class SearchEngine:
    def __init__(
        self, root_dir: str | os.PathLike[str], manager: SearchManager | None = None
    ) -> None:
        self.root_dir = Path(root_dir).resolve()
        self.manager = manager or SearchManager()

    def _rg_command(self, options: SearchOptions, notebooks: bool = False) -> list[str]:
        executable = shutil.which("rg")
        if executable is None:
            raise SearchError("ripgrep (rg) is not installed or is not on PATH")
        if notebooks:
            command = [executable, "--files", "--glob", "*.ipynb"]
        else:
            command = [
                executable,
                "--json",
                "--no-heading",
                "--max-count",
                str(options.max_matches_per_file),
                "--glob",
                "!*.ipynb",
            ]
            if not options.regex:
                command.append("--fixed-strings")
            if not options.case_sensitive:
                command.append("--ignore-case")
            if options.whole_word:
                command.append("--word-regexp")
        for pattern in options.includes:
            command.extend(["--glob", pattern])
        for pattern in options.excludes:
            command.extend(["--glob", f"!{pattern}"])
        if not notebooks:
            command.extend(["--", options.query, "."])
        return command

    async def events(self, options: SearchOptions) -> AsyncIterator[dict[str, Any]]:
        scope_path = resolve_scope(self.root_dir, options.scope)
        scope = str(PurePosixPath(options.scope.replace("\\", "/").strip("/")))
        if scope == ".":
            scope = ""
        job = self.manager.start(options.job_id)
        started = time.monotonic()
        total_matches = 0
        seen_files: set[str] = set()
        output_bytes = 0
        truncated_reason: str | None = None
        batch: list[dict[str, Any]] = []
        last_flush = started

        def flush_batch() -> dict[str, Any] | None:
            nonlocal batch, last_flush
            if not batch:
                return None
            event = {
                "type": "matches",
                "jobId": options.job_id,
                "matches": batch,
            }
            batch = []
            last_flush = time.monotonic()
            return event

        async def emit(matches: Iterable[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
            nonlocal total_matches, truncated_reason, batch, output_bytes
            for match in matches:
                path = str(match["path"])
                if path not in seen_files and len(seen_files) >= options.max_files:
                    truncated_reason = "file limit reached"
                    break
                seen_files.add(path)
                if total_matches >= options.max_matches:
                    truncated_reason = "match limit reached"
                    break
                output_bytes += len(
                    json.dumps(match, ensure_ascii=False).encode("utf-8")
                )
                if output_bytes > options.max_output_bytes:
                    truncated_reason = "output limit reached"
                    break
                batch.append(match)
                total_matches += 1
                if len(batch) >= options.batch_size:
                    event = flush_batch()
                    if event is not None:
                        yield event

        try:
            pattern = _compile_notebook_pattern(options)
            job.process = await StreamingProcess.start(
                self._rg_command(options),
                scope_path,
            )
            while not job.cancelled.is_set() and truncated_reason is None:
                now = time.monotonic()
                remaining = options.timeout_seconds - (now - started)
                if remaining <= 0:
                    truncated_reason = "time limit reached"
                    break
                wait_timeout = remaining
                if batch:
                    wait_timeout = min(
                        remaining,
                        max(0.001, BATCH_FLUSH_SECONDS - (now - last_flush)),
                    )
                try:
                    raw = await asyncio.wait_for(
                        job.process.readline(), timeout=wait_timeout
                    )
                except asyncio.TimeoutError:
                    if batch and time.monotonic() - started < options.timeout_seconds:
                        event = flush_batch()
                        if event is not None:
                            yield event
                        continue
                    truncated_reason = "time limit reached"
                    break
                if not raw:
                    break
                output_bytes += len(raw)
                if output_bytes > options.max_output_bytes:
                    truncated_reason = "output limit reached"
                    break
                try:
                    message = json.loads(raw)
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if message.get("type") != "match":
                    continue
                parsed = parse_rg_match(message, scope, options.max_line_length)
                async for event in emit(parsed):
                    yield event
                if batch and time.monotonic() - last_flush >= BATCH_FLUSH_SECONDS:
                    event = flush_batch()
                    if event is not None:
                        yield event
            if job.process.returncode is None:
                if truncated_reason or job.cancelled.is_set():
                    await job.cancel()
                else:
                    await job.process.wait()

            if not job.cancelled.is_set() and truncated_reason is None:
                event = flush_batch()
                if event is not None:
                    yield event
                job.process = await StreamingProcess.start(
                    self._rg_command(options, notebooks=True),
                    scope_path,
                )
                while not job.cancelled.is_set() and truncated_reason is None:
                    remaining = options.timeout_seconds - (time.monotonic() - started)
                    if remaining <= 0:
                        truncated_reason = "time limit reached"
                        break
                    try:
                        raw = await asyncio.wait_for(
                            job.process.readline(), timeout=remaining
                        )
                    except asyncio.TimeoutError:
                        truncated_reason = "time limit reached"
                        break
                    if not raw:
                        break
                    output_bytes += len(raw)
                    if output_bytes > options.max_output_bytes:
                        truncated_reason = "output limit reached"
                        break
                    relative = raw.decode("utf-8", errors="replace").strip()
                    display_path = str(
                        PurePosixPath(scope, relative.replace("\\", "/"))
                    )
                    if not _matches_globs(
                        relative, options.includes, options.excludes
                    ):
                        continue
                    matches = await asyncio.to_thread(
                        search_notebook,
                        scope_path / relative,
                        display_path,
                        pattern,
                        options,
                    )
                    async for event in emit(matches):
                        yield event
                    event = flush_batch()
                    if event is not None:
                        yield event
                if job.process.returncode is None:
                    if truncated_reason or job.cancelled.is_set():
                        await job.cancel()
                    else:
                        await job.process.wait()

            event = flush_batch()
            if event is not None:
                yield event
            yield {
                "type": "done",
                "jobId": options.job_id,
                "matchCount": total_matches,
                "fileCount": len(seen_files),
                "cancelled": job.cancelled.is_set(),
                "truncated": truncated_reason is not None,
                "reason": truncated_reason,
                "elapsedMs": round((time.monotonic() - started) * 1000),
            }
        finally:
            if job.process is not None and job.process.returncode is None:
                await job.cancel()
            self.manager.finish(options.job_id)
