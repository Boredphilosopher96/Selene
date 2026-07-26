import { chmod, link, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileLocalCollaborationAuthorPort } from './local-collaboration-author';

async function temporaryProfile(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `selene-${label}-`));
}

describe('FileLocalCollaborationAuthorPort', () => {
  it('persists one opaque author ID across desktop reopen', async () => {
    const profile = await temporaryProfile('collaboration-author');
    try {
      const path = join(profile, 'private-collaboration-v1', 'author.json');
      const first = await new FileLocalCollaborationAuthorPort(path).authorId();
      const reopened = await new FileLocalCollaborationAuthorPort(path).authorId();
      expect(reopened).toBe(first);
      expect(first).toMatch(/^local-designer-[0-9a-f-]{36}$/);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it('provisions different IDs for separate desktop profiles', async () => {
    const [firstProfile, secondProfile] = await Promise.all([
      temporaryProfile('collaboration-author-first'),
      temporaryProfile('collaboration-author-second')
    ]);
    try {
      const [first, second] = await Promise.all([
        new FileLocalCollaborationAuthorPort(
          join(firstProfile, 'private-collaboration-v1', 'author.json')
        ).authorId(),
        new FileLocalCollaborationAuthorPort(
          join(secondProfile, 'private-collaboration-v1', 'author.json')
        ).authorId()
      ]);
      expect(first).not.toBe(second);
    } finally {
      await Promise.all([
        rm(firstProfile, { recursive: true, force: true }),
        rm(secondProfile, { recursive: true, force: true })
      ]);
    }
  });

  it('converges concurrent store instances on one atomically published identity', async () => {
    const profile = await temporaryProfile('collaboration-author-concurrent');
    try {
      const path = join(profile, 'private-collaboration-v1', 'author.json');
      const identities = await Promise.all(
        Array.from({ length: 16 }, () => new FileLocalCollaborationAuthorPort(path).authorId())
      );
      expect(new Set(identities).size).toBe(1);
      await expect(new FileLocalCollaborationAuthorPort(path).authorId()).resolves.toBe(
        identities[0]
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked identity without following attacker-controlled contents', async () => {
    const profile = await temporaryProfile('collaboration-author-symlink');
    try {
      const directory = join(profile, 'private-collaboration-v1');
      const path = join(directory, 'author.json');
      const external = join(profile, 'external.json');
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        external,
        JSON.stringify({
          format: 'selene-local-collaboration-author/v1',
          authorId: 'local-designer-99999999-9999-4999-8999-999999999999'
        })
      );
      await symlink(external, path);
      await expect(new FileLocalCollaborationAuthorPort(path).authorId()).rejects.toThrow(
        'Local collaboration identity is invalid'
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it('rejects a multiply linked identity instead of trusting an aliased inode', async () => {
    const profile = await temporaryProfile('collaboration-author-hardlink');
    try {
      const directory = join(profile, 'private-collaboration-v1');
      const path = join(directory, 'author.json');
      const external = join(profile, 'external.json');
      await mkdir(directory, { mode: 0o700 });
      await writeFile(
        external,
        JSON.stringify({
          format: 'selene-local-collaboration-author/v1',
          authorId: 'local-designer-77777777-7777-4777-8777-777777777777'
        }),
        { mode: 0o600 }
      );
      await link(external, path);
      await expect(new FileLocalCollaborationAuthorPort(path).authorId()).rejects.toThrow(
        'Local collaboration identity is invalid'
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it('repairs and verifies restrictive directory and record permissions', async () => {
    const profile = await temporaryProfile('collaboration-author-permissions');
    try {
      const directory = join(profile, 'private-collaboration-v1');
      const path = join(directory, 'author.json');
      await mkdir(directory, { mode: 0o755 });
      await writeFile(
        path,
        JSON.stringify({
          format: 'selene-local-collaboration-author/v1',
          authorId: 'local-designer-88888888-8888-4888-8888-888888888888'
        }),
        { mode: 0o644 }
      );
      await chmod(directory, 0o755);
      await chmod(path, 0o644);

      await new FileLocalCollaborationAuthorPort(path).authorId();

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it('orders the temporary-file and containing-directory durability barriers', async () => {
    const profile = await temporaryProfile('collaboration-author-durability');
    try {
      const directory = join(profile, 'private-collaboration-v1');
      const path = join(directory, 'author.json');
      const events: string[] = [];
      await new FileLocalCollaborationAuthorPort(path, {
        async syncTemporary(handle) {
          await handle.sync();
          events.push('temporary');
        },
        async syncDirectory(syncedPath) {
          events.push(`directory:${syncedPath}`);
        }
      }).authorId();

      expect(events).toEqual([
        `directory:${directory}`,
        `directory:${profile}`,
        'temporary',
        `directory:${directory}`
      ]);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it('fails closed when the published directory entry cannot be synced and reuses that identity', async () => {
    const profile = await temporaryProfile('collaboration-author-sync-failure');
    try {
      const path = join(profile, 'private-collaboration-v1', 'author.json');
      let directorySyncs = 0;
      const failed = new FileLocalCollaborationAuthorPort(path, {
        async syncDirectory() {
          directorySyncs += 1;
          if (directorySyncs === 3) throw new Error('fixture directory sync failed');
        }
      });
      await expect(failed.authorId()).rejects.toThrow(
        'Local collaboration identity could not be saved'
      );
      const reopened = await new FileLocalCollaborationAuthorPort(path).authorId();
      expect(reopened).toMatch(/^local-designer-[0-9a-f-]{36}$/);
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });

  it('creates a missing identity but fails closed with recovery guidance for malformed state', async () => {
    const profile = await temporaryProfile('collaboration-author-invalid');
    try {
      const path = join(profile, 'private-collaboration-v1', 'author.json');
      await new FileLocalCollaborationAuthorPort(path).authorId();
      await writeFile(path, JSON.stringify({ format: 'wrong', authorId: 'renderer-spoof' }));
      await expect(new FileLocalCollaborationAuthorPort(path).authorId()).rejects.toThrow(
        'Local collaboration identity is invalid'
      );
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  });
});
