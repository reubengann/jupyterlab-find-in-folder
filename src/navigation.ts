import { JupyterFrontEnd } from '@jupyterlab/application';
import { CodeEditor } from '@jupyterlab/codeeditor';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { NotebookPanel } from '@jupyterlab/notebook';
import { Widget } from '@lumino/widgets';

import { ISearchMatch } from './types';

interface IEditorContent extends Widget {
  editor?: CodeEditor.IEditor;
}

export async function openSearchMatch(
  app: JupyterFrontEnd,
  docManager: IDocumentManager,
  match: ISearchMatch
): Promise<void> {
  const widget = docManager.openOrReveal(
    match.path,
    match.kind === 'notebook' ? 'Notebook' : 'Editor'
  );
  if (!widget) {
    throw new Error(`No document factory can open ${match.path}`);
  }
  app.shell.activateById(widget.id);
  await widget.context.ready;

  const start = { line: match.line, column: match.column };
  const end = { line: match.line, column: match.endColumn };
  if (match.kind === 'notebook' && widget instanceof NotebookPanel) {
    const index = match.cellIndex ?? 0;
    if (index < 0 || index >= widget.content.widgets.length) {
      throw new Error('The matching notebook cell no longer exists.');
    }
    widget.content.activeCellIndex = index;
    await widget.content.scrollToItem(index);
    const editor = widget.content.activeCell?.editor;
    editor?.setSelection({ start, end });
    editor?.focus();
    return;
  }

  const editor = (widget.content as IEditorContent).editor;
  if (!editor) {
    throw new Error(`The editor for ${match.path} is not available.`);
  }
  editor.setSelection({ start, end });
  editor.focus();
}
