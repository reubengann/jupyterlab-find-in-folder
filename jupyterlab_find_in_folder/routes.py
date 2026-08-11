from __future__ import annotations

from jupyter_server.utils import url_path_join

from .handlers import CancelSearchHandler, SearchHandler


def setup_route_handlers(web_app) -> None:
    base_url = web_app.settings["base_url"]
    api_root = url_path_join(base_url, "api", "jupyterlab-find-in-folder")
    web_app.add_handlers(
        ".*$",
        [
            (url_path_join(api_root, "search"), SearchHandler),
            (url_path_join(api_root, r"search/([A-Za-z0-9_-]+)"), CancelSearchHandler),
        ],
    )
