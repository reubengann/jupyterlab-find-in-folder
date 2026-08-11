# jupyterlab-find-in-folder

[![Github Actions Status](/workflows/Build/badge.svg)](/actions/workflows/build.yml)

A fast, search-only JupyterLab sidebar inspired by VS Code's Search view.
Searches are performed by `ripgrep` on the Jupyter server and streamed to the
browser in bounded batches, so large result sets do not create an unbounded
DOM tree or one enormous HTTP response.

Features:

- search below the current File Browser folder
- **Find in Folder** on a selected subfolder
- regular expression, match-case, whole-word, include, and exclude controls
- semantic search of code and Markdown cell source in notebooks
- direct navigation to text lines and notebook cells
- cancellation, stale-request protection, configurable limits, and a
  virtualized result list

## Requirements

- JupyterLab >= 4.0.0

## Install

To install the extension, execute:

```bash
pip install jupyterlab_find_in_folder
```

The extension depends on
[`ripgrep-bin`](https://pypi.org/project/ripgrep-bin/), which installs the
appropriate precompiled `rg` executable for the current platform. No separate
system installation or Rust toolchain is required.

## Use

Open **Find in Folder** from the command palette or press
<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>
(<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd> on macOS). The search scope
follows the current File Browser directory. To pin it to a subfolder,
right-click that folder and choose **Find in Folder**.

Results reflect saved content on disk. Ordinary files are searched by
ripgrep. Notebooks are parsed with `nbformat`; only code and Markdown cell
source is searched, never outputs, metadata, or attachments. Notebook regular
expressions use Python's regular-expression engine, while ordinary files use
ripgrep's engine, so uncommon engine-specific expressions may differ.

Searches exclude `.ipynb_checkpoints` by default. Result, file, response-size,
line-length, and time limits can be changed in JupyterLab's Settings Editor.
The server also clamps every requested limit to a safe upper bound.

## Uninstall

To remove the extension, execute:

```bash
pip uninstall jupyterlab_find_in_folder
```

## Contributing

If you would like to contribute to this extension, please refer to the [Contributing Guide](CONTRIBUTING.md).

Run checks with:

```bash
jlpm lint:check
jlpm test
python -m pytest
jlpm build
```
