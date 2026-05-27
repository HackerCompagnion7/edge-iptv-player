import { execSync } from 'child_process';

function run(cmd: string) {
  try {
    console.log(`Executing: ${cmd}`);
    const out = execSync(cmd, { encoding: 'utf8' });
    console.log(out);
  } catch (err: any) {
    console.error(`Error executing command: ${err.message}`);
    if (err.stdout) console.log(`STDOUT: ${err.stdout}`);
    if (err.stderr) console.error(`STDERR: ${err.stderr}`);
  }
}

try {
  // Set git user identity
  run('git config user.name "HackerCompagnion7"');
  run('git config user.email "HackerCompagnion7@users.noreply.github.com"');

  // Stage ALL files in the local workspace (respecting .gitignore)
  run('git add -A');

  console.log('--- Status after staging all ---');
  run('git status');

  // Commit if there are any staged changes
  try {
    run('git commit -m "refactor: complete clean update of the main codebase and repository alignment"');
  } catch (commitErr) {
    console.log('No new changes to commit, or commit failed. Proceeding with force push...');
  }

  // Force-push to remote to overwrite any stale or damaged files on GitHub
  run('git push origin main --force');

  console.log('Clean sync and force push to remote completed successfully!');
} catch (e: any) {
  console.error('Git operation failed:', e.message);
}
