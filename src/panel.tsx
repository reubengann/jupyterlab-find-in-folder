import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ReactWidget, searchIcon } from '@jupyterlab/ui-components';

import { SearchModel } from './model';
import { buildResultRows, groupMatches, ResultRow } from './results';
import { ISearchMatch, ISearchState } from './types';

interface ISearchPanelOptions {
  model: SearchModel;
  onOpenMatch: (match: ISearchMatch) => void;
  debounceMs: number;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function parseGlobs(value: string): string[] {
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function MatchPreview({ match }: { match: ISearchMatch }): JSX.Element {
  const start = Math.min(match.column, match.preview.length);
  const end = Math.min(Math.max(match.endColumn, start), match.preview.length);
  return (
    <>
      <span className="jp-FindInFolder-lineNumber">{match.line + 1}</span>
      <span className="jp-FindInFolder-previewText">
        {match.preview.slice(0, start)}
        <mark>{match.preview.slice(start, end)}</mark>
        {match.preview.slice(end)}
      </span>
    </>
  );
}

function VirtualResults(props: {
  matches: ISearchMatch[];
  onOpenMatch: (match: ISearchMatch) => void;
}): JSX.Element {
  const grouped = useMemo(() => groupMatches(props.matches), [props.matches]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement | null>(null);
  const rowHeight = 28;
  const rows = useMemo(
    () => buildResultRows(grouped, collapsed),
    [grouped, collapsed]
  );

  useEffect(() => {
    const node = container.current;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver(entries => {
      setHeight(entries[0]?.contentRect.height ?? node.clientHeight);
    });
    observer.observe(node);
    setHeight(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setActive(current => Math.min(current, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const last = Math.min(
    rows.length,
    Math.ceil((scrollTop + height) / rowHeight) + 5
  );
  const toggle = (path: string) => {
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };
  const activate = (row: ResultRow) => {
    if (row.type === 'file') {
      toggle(row.path);
    } else {
      props.onOpenMatch(row.match);
    }
  };
  const moveActive = (delta: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, active + delta));
    setActive(next);
    const node = container.current;
    if (!node) {
      return;
    }
    const top = next * rowHeight;
    if (top < node.scrollTop) {
      node.scrollTop = top;
    } else if (top + rowHeight > node.scrollTop + node.clientHeight) {
      node.scrollTop = top + rowHeight - node.clientHeight;
    }
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter' && rows[active]) {
      event.preventDefault();
      activate(rows[active]);
    }
  };

  return (
    <div
      className="jp-FindInFolder-results"
      ref={container}
      role="tree"
      tabIndex={0}
      aria-label="Search results"
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
      onKeyDown={onKeyDown}
    >
      <div
        className="jp-FindInFolder-resultsSizer"
        style={{ height: rows.length * rowHeight }}
      >
        {rows.slice(first, last).map((row, index) => {
          const rowIndex = first + index;
          if (row.type === 'file') {
            const isCollapsed = collapsed.has(row.path);
            return (
              <button
                type="button"
                role="treeitem"
                aria-expanded={!isCollapsed}
                className={`jp-FindInFolder-row jp-FindInFolder-fileRow${
                  active === rowIndex ? ' jp-mod-active' : ''
                }`}
                style={{ top: rowIndex * rowHeight }}
                key={`file:${row.path}`}
                title={row.path}
                onClick={() => {
                  setActive(rowIndex);
                  toggle(row.path);
                }}
              >
                <span aria-hidden="true">{isCollapsed ? '›' : '⌄'}</span>
                <strong>{basename(row.path)}</strong>
                <span className="jp-FindInFolder-filePath">{row.path}</span>
                <span className="jp-FindInFolder-count">{row.count}</span>
              </button>
            );
          }
          return (
            <button
              type="button"
              role="treeitem"
              aria-level={2}
              className={`jp-FindInFolder-row jp-FindInFolder-matchRow${
                active === rowIndex ? ' jp-mod-active' : ''
              }`}
              style={{ top: rowIndex * rowHeight }}
              key={`match:${row.path}:${row.match.cellIndex ?? ''}:${
                row.match.line
              }:${row.match.column}`}
              title={`${row.path}:${row.match.line + 1}`}
              onClick={() => {
                setActive(rowIndex);
                props.onOpenMatch(row.match);
              }}
            >
              <MatchPreview match={row.match} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SearchView(
  props: ISearchPanelOptions & {
    state: ISearchState;
    focusToken: number;
  }
): JSX.Element {
  const { model, state } = props;
  const input = useRef<HTMLInputElement | null>(null);
  const options = state.options;
  const [includeText, setIncludeText] = useState(options.includes.join(', '));
  const [excludeText, setExcludeText] = useState(options.excludes.join(', '));

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [props.focusToken]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void model.search();
    }, props.debounceMs);
    return () => window.clearTimeout(timer);
  }, [
    model,
    props.debounceMs,
    options.query,
    options.scope,
    options.regex,
    options.caseSensitive,
    options.wholeWord,
    options.includes.join('\0'),
    options.excludes.join('\0')
  ]);

  return (
    <div className="jp-FindInFolder-panel">
      <div className="jp-FindInFolder-searchBox">
        <input
          ref={input}
          type="search"
          value={options.query}
          placeholder="Search saved files"
          aria-label="Search saved files"
          onChange={event => model.updateOptions({ query: event.target.value })}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              void model.cancel();
            }
          }}
        />
        <button
          type="button"
          className={options.caseSensitive ? 'jp-mod-toggled' : ''}
          aria-pressed={options.caseSensitive}
          title="Match Case"
          onClick={() =>
            model.updateOptions({ caseSensitive: !options.caseSensitive })
          }
        >
          Aa
        </button>
        <button
          type="button"
          className={options.wholeWord ? 'jp-mod-toggled' : ''}
          aria-pressed={options.wholeWord}
          title="Match Whole Word"
          onClick={() => model.updateOptions({ wholeWord: !options.wholeWord })}
        >
          ab
        </button>
        <button
          type="button"
          className={options.regex ? 'jp-mod-toggled' : ''}
          aria-pressed={options.regex}
          title="Use Regular Expression"
          onClick={() => model.updateOptions({ regex: !options.regex })}
        >
          .*
        </button>
      </div>
      <div className="jp-FindInFolder-scope" title={options.scope || '/'}>
        in {options.scope || '/'} <span>· saved content</span>
      </div>
      <details className="jp-FindInFolder-details">
        <summary>Files to include / exclude</summary>
        <label>
          Include
          <input
            value={includeText}
            placeholder="e.g. **/*.py, src/**"
            onChange={event => {
              setIncludeText(event.target.value);
              model.updateOptions({ includes: parseGlobs(event.target.value) });
            }}
          />
        </label>
        <label>
          Exclude
          <input
            value={excludeText}
            onChange={event => {
              setExcludeText(event.target.value);
              model.updateOptions({ excludes: parseGlobs(event.target.value) });
            }}
          />
        </label>
      </details>
      <div
        className={`jp-FindInFolder-status${
          state.truncated ? ' jp-mod-warning' : ''
        }`}
        role="status"
      >
        <span>{state.error ?? state.status}</span>
        {state.searching ? (
          <button type="button" onClick={() => void model.cancel()}>
            Stop
          </button>
        ) : null}
      </div>
      {state.error ? (
        <div className="jp-FindInFolder-message jp-mod-error">
          {state.error}
        </div>
      ) : !state.searching && options.query && state.matches.length === 0 ? (
        <div className="jp-FindInFolder-message">No results found.</div>
      ) : (
        <VirtualResults
          matches={state.matches}
          onOpenMatch={props.onOpenMatch}
        />
      )}
    </div>
  );
}

export class SearchPanel extends ReactWidget {
  constructor(private options: ISearchPanelOptions) {
    super();
    this.id = 'jupyterlab-find-in-folder:panel';
    this.title.caption = 'Find in Folder';
    this.title.icon = searchIcon;
    this.title.closable = false;
    this.addClass('jp-FindInFolder');
    options.model.changed.connect(this._onModelChanged, this);
  }

  setScope(scope: string): void {
    this.options.model.setScope(scope);
  }

  focusSearch(): void {
    this._focusToken += 1;
    this.update();
  }

  dispose(): void {
    this.options.model.changed.disconnect(this._onModelChanged, this);
    void this.options.model.cancel();
    super.dispose();
  }

  render(): JSX.Element {
    return (
      <SearchView
        {...this.options}
        state={this.options.model.state}
        focusToken={this._focusToken}
      />
    );
  }

  private _onModelChanged(): void {
    this.update();
  }

  private _focusToken = 0;
}
