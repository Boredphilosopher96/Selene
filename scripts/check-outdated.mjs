const command = Bun.spawn(['bun', 'outdated', '--recursive', '--no-cache', '--no-save'], {
  stdout: 'pipe',
  stderr: 'pipe'
});

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(command.stdout).text(),
  new Response(command.stderr).text(),
  command.exited
]);

process.stdout.write(stdout);
process.stderr.write(stderr);

if (exitCode !== 0) {
  throw new Error(`bun outdated failed with exit code ${exitCode}.`);
}

const outdatedRows = stdout.split('\n').filter((line) => {
  const cells = line.split('|').map((cell) => cell.trim());
  return (
    cells.length >= 7 &&
    cells[1] !== 'Package' &&
    cells[1] !== '' &&
    !/^[-]+$/.test(cells[1]) &&
    cells[2] !== cells[4]
  );
});

if (outdatedRows.length > 0) {
  throw new Error(`Found ${outdatedRows.length} outdated workspace dependencies.`);
}

console.log('All workspace dependencies match the live registry latest stable versions.');
