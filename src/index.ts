import {
  ILayoutRestorer,
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';
import { ICommandPalette, showErrorMessage } from '@jupyterlab/apputils';
import { IDocumentManager } from '@jupyterlab/docmanager';
import { IDefaultFileBrowser } from '@jupyterlab/filebrowser';
import { ISettingRegistry } from '@jupyterlab/settingregistry';

import { SearchModel, DEFAULT_LIMITS } from './model';
import { openSearchMatch } from './navigation';
import { SearchPanel } from './panel';

export const PLUGIN_ID = 'jupyterlab-find-in-folder:plugin';
export const OPEN_COMMAND = 'jupyterlab-find-in-folder:open';
export const SEARCH_FOLDER_COMMAND =
  'jupyterlab-find-in-folder:search-selected-folder';

/**
 * Initialization data for the jupyterlab-find-in-folder extension.
 */
const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Fast, scoped text search across files and notebook sources.',
  autoStart: true,
  requires: [ILayoutRestorer, IDefaultFileBrowser, IDocumentManager],
  optional: [ISettingRegistry, ICommandPalette],
  activate: async (
    app: JupyterFrontEnd,
    restorer: ILayoutRestorer,
    browser: IDefaultFileBrowser,
    docManager: IDocumentManager,
    settingRegistry: ISettingRegistry | null,
    palette: ICommandPalette | null
  ) => {
    const model = new SearchModel();
    let debounceMs = 250;
    if (settingRegistry) {
      try {
        const settings = await settingRegistry.load(PLUGIN_ID);
        const applySettings = (applyDefaults: boolean) => {
          const composite = settings.composite;
          debounceMs = Number(composite['debounceMs'] ?? 250);
          model.configure({
            ...DEFAULT_LIMITS,
            maxMatches: Number(
              composite['maxMatches'] ?? DEFAULT_LIMITS.maxMatches
            ),
            maxFiles: Number(composite['maxFiles'] ?? DEFAULT_LIMITS.maxFiles),
            maxMatchesPerFile: Number(
              composite['maxMatchesPerFile'] ?? DEFAULT_LIMITS.maxMatchesPerFile
            ),
            maxOutputBytes: Number(
              composite['maxOutputBytes'] ?? DEFAULT_LIMITS.maxOutputBytes
            ),
            maxLineLength: Number(
              composite['maxLineLength'] ?? DEFAULT_LIMITS.maxLineLength
            ),
            timeoutSeconds: Number(
              composite['timeoutSeconds'] ?? DEFAULT_LIMITS.timeoutSeconds
            ),
            batchSize: Number(
              composite['batchSize'] ?? DEFAULT_LIMITS.batchSize
            )
          });
          const defaultExcludes = composite['defaultExcludes'];
          if (applyDefaults) {
            model.updateOptions({
              excludes: Array.isArray(defaultExcludes)
                ? defaultExcludes.filter(
                    (item): item is string => typeof item === 'string'
                  )
                : model.state.options.excludes,
              regex: Boolean(composite['defaultRegex']),
              caseSensitive: Boolean(composite['defaultCaseSensitive']),
              wholeWord: Boolean(composite['defaultWholeWord'])
            });
          }
        };
        applySettings(true);
        settings.changed.connect(() => applySettings(false));
      } catch (error) {
        console.warn('Could not load Find in Folder settings.', error);
      }
    }

    const panel = new SearchPanel({
      model,
      debounceMs,
      onOpenMatch: match => {
        void openSearchMatch(app, docManager, match).catch(error =>
          showErrorMessage('Could not open search result', String(error))
        );
      }
    });
    model.setScope(browser.model.path);
    app.shell.add(panel, 'left', { rank: 150 });
    restorer.add(panel, PLUGIN_ID);

    let hasExplicitScope = false;
    browser.model.pathChanged.connect((_sender, path) => {
      if (!hasExplicitScope) {
        panel.setScope(path.newValue);
      }
    });

    app.commands.addCommand(OPEN_COMMAND, {
      describedBy: { args: null },
      label: 'Find in Folder',
      caption: 'Search files beneath the current File Browser folder',
      icon: panel.title.icon,
      execute: () => {
        hasExplicitScope = false;
        panel.setScope(browser.model.path);
        app.shell.activateById(panel.id);
        panel.focusSearch();
      }
    });
    app.commands.addKeyBinding({
      command: OPEN_COMMAND,
      keys: ['Accel Shift F'],
      selector: 'body'
    });
    palette?.addItem({ command: OPEN_COMMAND, category: 'File Operations' });

    app.commands.addCommand(SEARCH_FOLDER_COMMAND, {
      describedBy: { args: null },
      label: 'Find in Folder',
      caption: 'Search within the selected folder',
      isVisible: () => {
        const selected = Array.from(browser.selectedItems());
        return selected.length === 1 && selected[0].type === 'directory';
      },
      execute: () => {
        const selected = Array.from(browser.selectedItems());
        const folder = selected.find(item => item.type === 'directory');
        if (!folder) {
          return;
        }
        hasExplicitScope = true;
        panel.setScope(folder.path);
        app.shell.activateById(panel.id);
        panel.focusSearch();
      }
    });
    app.contextMenu.addItem({
      command: SEARCH_FOLDER_COMMAND,
      selector: '.jp-DirListing-item[data-isdir="true"]',
      rank: 15
    });
  }
};

export default plugin;
