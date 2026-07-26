import { writeDeveloperHandoffArtifacts } from './developer-handoff-archive.mjs';

if (process.argv.length > 2)
  throw new Error('Developer handoff output is fixed to the public asset root');
const result = await writeDeveloperHandoffArtifacts();
process.stdout.write(
  `Wrote ${result.archivePath} and ${result.receiptPath} (${result.bytes} archive bytes, sha256:${result.digest})\n`
);
