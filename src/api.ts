import { URLExt } from '@jupyterlab/coreutils';
import { ServerConnection } from '@jupyterlab/services';

import { ISearchLimits, ISearchOptions, SearchEvent } from './types';

function newJobId(): string {
  const random = Math.random().toString(36).slice(2);
  return `search-${Date.now().toString(36)}-${random}`;
}

export class SearchApi {
  constructor(private settings = ServerConnection.makeSettings()) {}

  get activeJobId(): string | null {
    return this._activeJobId;
  }

  async search(
    options: ISearchOptions,
    limits: ISearchLimits,
    onEvent: (event: SearchEvent) => void
  ): Promise<string> {
    await this.cancel();
    const jobId = newJobId();
    const controller = new AbortController();
    this._activeJobId = jobId;
    this._controller = controller;
    const url = URLExt.join(
      this.settings.baseUrl,
      'api',
      'jupyterlab-find-in-folder',
      'search'
    );
    const response = await ServerConnection.makeRequest(
      url,
      {
        method: 'POST',
        body: JSON.stringify({ ...options, ...limits, jobId }),
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      },
      this.settings
    );
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`;
      try {
        const payload = (await response.json()) as { error?: string };
        message = payload.error ?? message;
      } catch {
        // Preserve the HTTP status when the response was not JSON.
      }
      throw new Error(message);
    }
    if (!response.body) {
      throw new Error('The search server returned no response stream.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          onEvent(JSON.parse(line) as SearchEvent);
        }
        if (done) {
          if (pending.trim()) {
            onEvent(JSON.parse(pending) as SearchEvent);
          }
          break;
        }
      }
      return jobId;
    } finally {
      if (this._activeJobId === jobId) {
        this._activeJobId = null;
        this._controller = null;
      }
      reader.releaseLock();
    }
  }

  async cancel(): Promise<void> {
    const jobId = this._activeJobId;
    const controller = this._controller;
    if (!jobId) {
      return;
    }
    this._activeJobId = null;
    this._controller = null;
    controller?.abort();
    const url = URLExt.join(
      this.settings.baseUrl,
      'api',
      'jupyterlab-find-in-folder',
      'search',
      jobId
    );
    try {
      await ServerConnection.makeRequest(
        url,
        { method: 'DELETE' },
        this.settings
      );
    } catch {
      // Aborting the POST already closes the stream; DELETE is best effort.
    }
  }

  private _activeJobId: string | null = null;
  private _controller: AbortController | null = null;
}
