import { readFile } from 'node:fs/promises';

export function validateReleaseReference({ tag, sha, version, resolveCommit }) {
  if (!tag && !sha) return undefined;
  if (!tag || !sha)
    throw new Error('SELENE_RELEASE_TAG and SELENE_RELEASE_SHA must be supplied together.');
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
    throw new Error(`Release tag ${tag} is not a supported semantic-version tag.`);
  }
  if (!/^[0-9a-f]{40}$/i.test(sha))
    throw new Error('SELENE_RELEASE_SHA must be a full 40-character commit SHA.');

  const tagVersion = tag.replace(/^v/, '');
  if (tagVersion !== version) {
    throw new Error(`Release tag ${tag} does not match product version ${version}.`);
  }

  const tagCommit = resolveCommit(tag);
  const requestedCommit = resolveCommit(sha);
  if (tagCommit !== requestedCommit) {
    throw new Error(
      `Release tag ${tag} resolves to ${tagCommit}, not requested SHA ${requestedCommit}.`
    );
  }
  return { tag, sha: requestedCommit, version };
}

const gitResolveCommit = (reference) => {
  const result = Bun.spawnSync({
    cmd: ['git', 'rev-parse', `${reference}^{commit}`],
    stdout: 'pipe',
    stderr: 'pipe'
  });
  if (!result.success) throw new Error(`Unable to resolve ${reference} as a commit.`);
  return new TextDecoder().decode(result.stdout).trim();
};

if (import.meta.main) {
  const tag = process.env.SELENE_RELEASE_TAG;
  const sha = process.env.SELENE_RELEASE_SHA;
  const rootManifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  );
  const verified = validateReleaseReference({
    tag,
    sha,
    version: rootManifest.version,
    resolveCommit: gitResolveCommit
  });
  if (!verified) {
    console.log(
      'No release tag/SHA requested; building checked-out source without draft-release eligibility.'
    );
  } else {
    console.log(
      `Verified release tag ${verified.tag} at exact commit ${verified.sha} for ${verified.version}.`
    );
  }
}
