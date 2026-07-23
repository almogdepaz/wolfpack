export function filterProjectNames(projects: readonly string[], query: string): readonly string[] {
  const prefix = query.trim().toLowerCase();
  if (!prefix) return projects;
  return projects.filter((project) => project.toLowerCase().startsWith(prefix));
}
