import { ISignal, Signal } from '@lumino/signaling';

import { SearchApi } from './api';
import {
  ISearchLimits,
  ISearchOptions,
  ISearchState,
  SearchEvent
} from './types';

export interface ISearchApi {
  search(
    options: ISearchOptions,
    limits: ISearchLimits,
    onEvent: (event: SearchEvent) => void
  ): Promise<string>;
  cancel(): Promise<void>;
}

export const DEFAULT_LIMITS: ISearchLimits = {
  maxMatches: 10_000,
  maxFiles: 2_000,
  maxMatchesPerFile: 500,
  maxOutputBytes: 20_000_000,
  maxLineLength: 20_000,
  timeoutSeconds: 30,
  batchSize: 100
};

const DEFAULT_OPTIONS: ISearchOptions = {
  query: '',
  scope: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  includes: [],
  excludes: ['**/.ipynb_checkpoints/**']
};

export class SearchModel {
  constructor(private api: ISearchApi = new SearchApi()) {}

  get changed(): ISignal<this, ISearchState> {
    return this._changed;
  }

  get state(): ISearchState {
    return this._state;
  }

  get limits(): ISearchLimits {
    return this._limits;
  }

  configure(limits: Partial<ISearchLimits>): void {
    this._limits = { ...this._limits, ...limits };
  }

  updateOptions(options: Partial<ISearchOptions>): void {
    this._setState({
      ...this._state,
      options: { ...this._state.options, ...options }
    });
  }

  setScope(scope: string): void {
    this.updateOptions({ scope });
  }

  async search(): Promise<void> {
    const query = this._state.options.query;
    const generation = ++this._generation;
    if (!query) {
      await this.api.cancel();
      this._setState({
        ...this._state,
        matches: [],
        searching: false,
        status: '',
        error: null,
        truncated: false
      });
      return;
    }
    this._setState({
      ...this._state,
      matches: [],
      searching: true,
      status: 'Searching saved files…',
      error: null,
      truncated: false
    });
    try {
      await this.api.search(this._state.options, this._limits, event => {
        if (generation === this._generation) {
          this._handleEvent(event);
        }
      });
    } catch (error) {
      if (generation !== this._generation) {
        return;
      }
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      this._setState({
        ...this._state,
        searching: false,
        status: '',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async cancel(): Promise<void> {
    ++this._generation;
    await this.api.cancel();
    this._setState({
      ...this._state,
      searching: false,
      status: this._state.matches.length
        ? `${this._state.matches.length} matches (cancelled)`
        : 'Search cancelled'
    });
  }

  private _handleEvent(event: SearchEvent): void {
    if (event.type === 'matches') {
      const matches = [...this._state.matches, ...event.matches].slice(
        0,
        this._limits.maxMatches
      );
      this._setState({
        ...this._state,
        matches,
        status: `Searching… ${matches.length} matches`
      });
      return;
    }
    if (event.type === 'error') {
      this._setState({
        ...this._state,
        searching: false,
        status: '',
        error: event.message
      });
      return;
    }
    const noun = event.matchCount === 1 ? 'match' : 'matches';
    this._setState({
      ...this._state,
      searching: false,
      status: `${event.matchCount} ${noun} in ${event.fileCount} files${
        event.truncated ? ` — limited: ${event.reason}` : ''
      }`,
      truncated: event.truncated
    });
  }

  private _setState(state: ISearchState): void {
    this._state = state;
    this._changed.emit(state);
  }

  private _state: ISearchState = {
    options: DEFAULT_OPTIONS,
    matches: [],
    searching: false,
    status: '',
    error: null,
    truncated: false
  };
  private _limits = DEFAULT_LIMITS;
  private _generation = 0;
  private _changed = new Signal<this, ISearchState>(this);
}
