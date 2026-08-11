import { ISearchMatch } from './types';

export type ResultRow =
  | { type: 'file'; path: string; count: number }
  | { type: 'match'; path: string; match: ISearchMatch };

export function groupMatches(
  matches: ISearchMatch[]
): Map<string, ISearchMatch[]> {
  const groups = new Map<string, ISearchMatch[]>();
  for (const match of matches) {
    const existing = groups.get(match.path);
    if (existing) {
      existing.push(match);
    } else {
      groups.set(match.path, [match]);
    }
  }
  return groups;
}

export function buildResultRows(
  grouped: Map<string, ISearchMatch[]>,
  collapsed: Set<string>
): ResultRow[] {
  const result: ResultRow[] = [];
  for (const [path, matches] of grouped) {
    result.push({ type: 'file', path, count: matches.length });
    if (!collapsed.has(path)) {
      for (const match of matches) {
        result.push({ type: 'match', path, match });
      }
    }
  }
  return result;
}
