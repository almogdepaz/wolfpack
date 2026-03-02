export async function git(
  projectDir: string,
  ...args: string[]
): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: projectDir,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `git ${args[0]} failed (exit ${exitCode}): ${stderr.slice(0, 200)}`,
    );
  }

  return stdout.trim();
}
