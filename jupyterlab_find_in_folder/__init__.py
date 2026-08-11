try:
    from ._version import __version__
except ImportError:
    # Fallback when using the package in dev mode without installing
    # in editable mode with pip. It is highly recommended to install
    # the package from a stable release or in editable mode: https://pip.pypa.io/en/stable/topics/local-project-installs/#editable-installs
    import warnings
    warnings.warn("Importing 'jupyterlab_find_in_folder' outside a proper installation.")
    __version__ = "dev"

from .routes import setup_route_handlers


def _jupyter_labextension_paths():
    return [{
        "src": "labextension",
        "dest": "jupyterlab-find-in-folder"
    }]


def _jupyter_server_extension_points():
    return [{"module": "jupyterlab_find_in_folder"}]


def _load_jupyter_server_extension(server_app):
    """Register the authenticated search API."""
    setup_route_handlers(server_app.web_app)
    server_app.log.info("Registered jupyterlab_find_in_folder server extension")
