from __future__ import annotations

import inspect
import json
from http import HTTPStatus
from typing import Any

import tornado.web
from jupyter_server.base.handlers import APIHandler
from tornado.iostream import StreamClosedError

from .search import SearchEngine, SearchError, SearchManager, SearchOptions, resolve_scope


class BaseSearchHandler(APIHandler):
    async def prepare(self) -> None:
        prepared = super().prepare()
        if inspect.isawaitable(prepared):
            await prepared

    @property
    def manager(self) -> SearchManager:
        manager = self.settings.get("find_in_folder_search_manager")
        if not isinstance(manager, SearchManager):
            manager = SearchManager()
            self.settings["find_in_folder_search_manager"] = manager
        return manager

    @property
    def root_dir(self) -> str:
        root_dir = getattr(self.contents_manager, "root_dir", None)
        if not root_dir:
            raise SearchError(
                "Find in Folder requires a local ContentsManager with a root_dir"
            )
        return str(root_dir)

    def write_json_error(self, status: HTTPStatus, message: str) -> None:
        self.set_status(status)
        self.set_header("Content-Type", "application/json")
        self.finish(json.dumps({"error": message}))

    def parse_body(self) -> dict[str, Any]:
        try:
            body = self.get_json_body()
        except Exception as error:
            raise SearchError(
                "Request body must be valid JSON with Content-Type: application/json"
            ) from error
        if not isinstance(body, dict):
            raise SearchError("Request body must be a JSON object")
        return body


class SearchHandler(BaseSearchHandler):
    _job_id: str | None = None

    @tornado.web.authenticated
    async def post(self) -> None:
        try:
            options = SearchOptions.from_json(self.parse_body())
            resolve_scope(self.root_dir, options.scope)
        except SearchError as error:
            self.write_json_error(HTTPStatus.BAD_REQUEST, str(error))
            return

        self._job_id = options.job_id
        self.set_header("Content-Type", "application/x-ndjson; charset=UTF-8")
        self.set_header("Cache-Control", "no-store")
        self.set_header("X-Content-Type-Options", "nosniff")
        engine = SearchEngine(self.root_dir, self.manager)
        try:
            async for event in engine.events(options):
                self.write(json.dumps(event, ensure_ascii=False) + "\n")
                await self.flush()
        except SearchError as error:
            if not self._finished:
                self.write(
                    json.dumps(
                        {
                            "type": "error",
                            "jobId": options.job_id,
                            "message": str(error),
                        }
                    )
                    + "\n"
                )
        except StreamClosedError:
            await self.manager.cancel(options.job_id)
        except Exception as error:
            self.log.exception("Find in Folder search failed")
            if not self._finished:
                self.write(
                    json.dumps(
                        {
                            "type": "error",
                            "jobId": options.job_id,
                            "message": f"Search failed: {error}",
                        }
                    )
                    + "\n"
                )
        finally:
            if not self._finished:
                self.finish()

    def on_connection_close(self) -> None:
        super().on_connection_close()
        if self._job_id:
            self.io_loop.spawn_callback(self.manager.cancel, self._job_id)


class CancelSearchHandler(BaseSearchHandler):
    @tornado.web.authenticated
    async def delete(self, job_id: str) -> None:
        cancelled = await self.manager.cancel(job_id)
        self.set_status(HTTPStatus.NO_CONTENT if cancelled else HTTPStatus.NOT_FOUND)
        self.finish()
