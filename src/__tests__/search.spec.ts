jest.mock('../api', () => ({ SearchApi: class {} }));

import { ISearchApi, SearchModel } from '../model';
import { buildResultRows, groupMatches } from '../results';
import {
  ISearchLimits,
  ISearchMatch,
  ISearchOptions,
  SearchEvent
} from '../types';

class FakeSearchApi implements ISearchApi {
  callbacks: Array<(event: SearchEvent) => void> = [];
  resolvers: Array<(jobId: string) => void> = [];

  async search(
    _options: ISearchOptions,
    _limits: ISearchLimits,
    onEvent: (event: SearchEvent) => void
  ): Promise<string> {
    this.callbacks.push(onEvent);
    return new Promise(resolve => this.resolvers.push(resolve));
  }

  async cancel(): Promise<void> {
    return Promise.resolve();
  }
}

function match(path: string, line = 0): ISearchMatch {
  return {
    path,
    kind: 'file',
    line,
    column: 0,
    endColumn: 6,
    preview: 'needle'
  };
}

describe('SearchModel', () => {
  it('ignores events from a superseded request', async () => {
    const api = new FakeSearchApi();
    const model = new SearchModel(api);
    model.updateOptions({ query: 'first' });
    const first = model.search();
    await Promise.resolve();
    model.updateOptions({ query: 'second' });
    const second = model.search();
    await Promise.resolve();

    api.callbacks[0]({
      type: 'matches',
      jobId: 'old',
      matches: [match('old.txt')]
    });
    expect(model.state.matches).toHaveLength(0);

    api.callbacks[1]({
      type: 'matches',
      jobId: 'new',
      matches: [match('new.txt')]
    });
    expect(model.state.matches.map(item => item.path)).toEqual(['new.txt']);

    api.resolvers[0]('old');
    api.resolvers[1]('new');
    await Promise.all([first, second]);
  });

  it('bounds retained matches', async () => {
    const api = new FakeSearchApi();
    const model = new SearchModel(api);
    model.configure({ maxMatches: 1 });
    model.updateOptions({ query: 'needle' });
    const pending = model.search();
    await Promise.resolve();
    api.callbacks[0]({
      type: 'matches',
      jobId: 'job',
      matches: [match('a.txt'), match('b.txt')]
    });
    expect(model.state.matches).toHaveLength(1);
    api.resolvers[0]('job');
    await pending;
  });
});

describe('result rows', () => {
  it('groups files and omits collapsed match rows', () => {
    const grouped = groupMatches([
      match('a.txt', 0),
      match('a.txt', 1),
      match('b.txt', 0)
    ]);
    const rows = buildResultRows(grouped, new Set(['a.txt']));
    expect(rows.map(row => `${row.type}:${row.path}`)).toEqual([
      'file:a.txt',
      'file:b.txt',
      'match:b.txt'
    ]);
  });
});
