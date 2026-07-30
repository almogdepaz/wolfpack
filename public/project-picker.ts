export function filterProjectNames(projects: readonly string[], query: string): readonly string[] {
  const prefix = query.trim().toLowerCase();
  if (!prefix) return projects;
  return projects.filter((project) => project.toLowerCase().startsWith(prefix));
}

export function rankProjectNames(
  projects: readonly string[],
  query: string,
  recents: readonly string[],
  limit = 12,
): readonly string[] {
  const matches = filterProjectNames(projects, query);
  const matchSet = new Set(matches);
  const ranked: string[] = [];
  const add = (project: string): void => {
    if (matchSet.has(project) && !ranked.includes(project)) ranked.push(project);
  };
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery) {
    const exact = matches.find((project) => project.toLowerCase() === normalizedQuery);
    if (exact) add(exact);
  }
  for (const project of recents) add(project);
  for (const project of matches) add(project);
  return ranked.slice(0, Math.max(0, limit));
}
