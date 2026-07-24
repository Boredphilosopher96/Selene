import { spawnSync } from 'bun';

const tag = process.env.SELENE_RELEASE_TAG;
const sha = process.env.SELENE_RELEASE_SHA;

if (!tag && !sha) {
  console.log(
    'No release tag/SHA requested; building checked-out source without draft-release eligibility.'
  );
  process.exit(0);
}
if (!tag || !sha)
  throw new Error('SELENE_RELEASE_TAG and SELENE_RELEASE_SHA must be supplied together.');
if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  throw new Error(`Release tag ${tag} is not a supported semantic-version tag.`);
}
if (!/^[0-9a-f]{40}$/i.test(sha))
  throw new Error('SELENE_RELEASE_SHA must be a full 40-character commit SHA.');

const resolveCommit = (reference) => {
  const result = spawnSync({
    cmd: ['git', 'rev-parse', `${reference}^{commit}`],
    stdout: 'pipe',
    stderr: 'pipe'
  });
  if (!result.success) throw new Error(`Unable to resolve ${reference} as a commit.`);
  return new TextDecoder().decode(result.stdout).trim();
};

const tagCommit = resolveCommit(tag);
const requestedCommit = resolveCommit(sha);
if (tagCommit !== requestedCommit) {
  throw new Error(
    `Release tag ${tag} resolves to ${tagCommit}, not requested SHA ${requestedCommit}.`
  );
}
console.log(`Verified release tag ${tag} at exact commit ${requestedCommit}.`);
