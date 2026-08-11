export interface ISearchMatch {
  path: string;
  kind: 'file' | 'notebook';
  line: number;
  column: number;
  endColumn: number;
  preview: string;
  cellIndex?: number;
  cellId?: string;
  cellType?: 'code' | 'markdown';
}

export interface ISearchOptions {
  query: string;
  scope: string;
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  includes: string[];
  excludes: string[];
}

export interface ISearchLimits {
  maxMatches: number;
  maxFiles: number;
  maxMatchesPerFile: number;
  maxOutputBytes: number;
  maxLineLength: number;
  timeoutSeconds: number;
  batchSize: number;
}

export interface ISearchDone {
  type: 'done';
  jobId: string;
  matchCount: number;
  fileCount: number;
  cancelled: boolean;
  truncated: boolean;
  reason: string | null;
  elapsedMs: number;
}

export type SearchEvent =
  | {
      type: 'matches';
      jobId: string;
      matches: ISearchMatch[];
    }
  | ISearchDone
  | {
      type: 'error';
      jobId: string;
      message: string;
    };

export interface ISearchState {
  options: ISearchOptions;
  matches: ISearchMatch[];
  searching: boolean;
  status: string;
  error: string | null;
  truncated: boolean;
}
