import {
  canonicalBackupJson,
  parseProjectBackup,
  projectSnapshotIdentity,
  type ProjectBackup,
  type ProjectRestoreReceipt
} from '../../collaboration-service/src/project-backup-contract';

export const encryptedProjectBackupMaxBytes = 3 * 1024 * 1024;
const iterations = 310_000;
const encoder = new TextEncoder();
function base64(data: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < data.length; offset += 8192)
    value += String.fromCharCode(...data.subarray(offset, offset + 8192));
  return btoa(value);
}
function bytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (
    typeof value !== 'string' ||
    value.length > encryptedProjectBackupMaxBytes ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error('Encrypted backup is invalid');
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
async function key(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (passphrase.length < 12 || encoder.encode(passphrase).byteLength > 1024)
    throw new Error('Use a backup passphrase from 12 to 1024 characters');
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
export async function verifyProjectBackup(value: unknown): Promise<ProjectBackup> {
  const backup = parseProjectBackup(value);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(canonicalBackupJson(backup.document))
  );
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  if (actual !== backup.sha256) throw new Error('Backup checksum does not match');
  return backup;
}
async function snapshotDigest(backup: ProjectBackup): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(projectSnapshotIdentity(backup.document.snapshot))
  );
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
export async function encryptProjectBackup(value: unknown, passphrase: string): Promise<string> {
  const backup = await verifyProjectBackup(value);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode('selene-encrypted-project-backup/v1') },
    await key(passphrase, salt),
    encoder.encode(JSON.stringify(backup))
  );
  const serialized = JSON.stringify({
    format: 'selene-encrypted-project-backup/v1',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: base64(salt),
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext))
  });
  if (encoder.encode(serialized).byteLength > encryptedProjectBackupMaxBytes)
    throw new Error('Encrypted backup exceeds the supported size');
  return serialized;
}
export async function decryptProjectBackup(
  serialized: string,
  passphrase: string
): Promise<ProjectBackup> {
  if (encoder.encode(serialized).byteLength > encryptedProjectBackupMaxBytes)
    throw new Error('Encrypted backup exceeds the supported size');
  try {
    const envelope: unknown = JSON.parse(serialized);
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope))
      throw new Error();
    const input = envelope as Record<string, unknown>;
    if (
      Object.keys(input).sort().join(',') !== 'ciphertext,format,iterations,iv,kdf,salt' ||
      input.format !== 'selene-encrypted-project-backup/v1' ||
      input.kdf !== 'PBKDF2-SHA256' ||
      input.iterations !== iterations
    )
      throw new Error();
    const salt = bytes(input.salt);
    const iv = bytes(input.iv);
    if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error();
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode('selene-encrypted-project-backup/v1') },
      await key(passphrase, salt),
      bytes(input.ciphertext)
    );
    return await verifyProjectBackup(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted))
    );
  } catch {
    throw new Error(
      'The backup could not be decrypted or verified. Check the file and passphrase.'
    );
  }
}
export interface ProjectRecoveryActions {
  backup(projectId: string, retentionDays: number): Promise<ProjectBackup>;
  restore(backup: ProjectBackup, expectedRevisionId: string): Promise<ProjectRestoreReceipt>;
}
export function createProjectRecoveryBrowserClient(
  apiOrigin: string,
  transport: typeof fetch = fetch
): ProjectRecoveryActions {
  const origin = new URL(apiOrigin);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.href !== `${origin.origin}/`
  )
    throw new Error('Recovery API origin is invalid');
  const call = async (path: string, options: RequestInit): Promise<unknown> => {
    const response = await transport(`${origin.origin}${path}`, {
      ...options,
      credentials: 'include',
      redirect: 'error'
    });
    if (!response.ok)
      throw new Error(
        response.status === 403
          ? 'Project recovery requires owner or admin access.'
          : response.status === 409
            ? 'The project changed. Refresh its revision before restoring.'
            : 'Project recovery is unavailable.'
      );
    return response.json();
  };
  return {
    async backup(projectId, retentionDays) {
      return verifyProjectBackup(
        await call(
          `/v1/projects/${encodeURIComponent(projectId)}/backup?retentionDays=${retentionDays}`,
          {}
        )
      );
    },
    async restore(backup, expectedRevisionId) {
      const verified = await verifyProjectBackup(backup);
      const receipt = await call(
        `/v1/projects/${encodeURIComponent(verified.document.projectId)}/restore`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ backup: verified, expectedRevisionId })
        }
      );
      if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt))
        throw new Error('Restore receipt is invalid');
      const value = receipt as Record<string, unknown>;
      if (
        Object.keys(value).sort().join(',') !==
          'format,preservedAuditIds,previousRevisionId,projectId,restoreAuditId,restoredAt,restoredRevisionId,snapshotSha256,tenantId' ||
        value.format !== 'selene-project-restore-receipt/v1' ||
        value.projectId !== verified.document.projectId ||
        value.tenantId !== verified.document.tenantId ||
        value.previousRevisionId !== expectedRevisionId ||
        value.restoredRevisionId !== verified.document.latestRevisionId ||
        typeof value.snapshotSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.snapshotSha256) ||
        typeof value.restoreAuditId !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.restoreAuditId) ||
        typeof value.restoredAt !== 'string' ||
        !Number.isFinite(Date.parse(value.restoredAt)) ||
        new Date(value.restoredAt).toISOString() !== value.restoredAt ||
        !Array.isArray(value.preservedAuditIds) ||
        value.preservedAuditIds.length > 1000 ||
        value.preservedAuditIds.some((id) => typeof id !== 'string')
      )
        throw new Error('Restore receipt is invalid');
      if (
        value.snapshotSha256 !== (await snapshotDigest(verified)) ||
        canonicalBackupJson([...value.preservedAuditIds].sort()) !==
          canonicalBackupJson(verified.document.audits.map((audit) => audit.id).sort())
      )
        throw new Error('Restore receipt does not match the backed-up identities');
      return {
        format: 'selene-project-restore-receipt/v1',
        projectId: verified.document.projectId,
        tenantId: verified.document.tenantId,
        previousRevisionId: expectedRevisionId,
        restoredRevisionId: verified.document.latestRevisionId,
        snapshotSha256: value.snapshotSha256,
        restoreAuditId: value.restoreAuditId,
        restoredAt: value.restoredAt,
        preservedAuditIds: value.preservedAuditIds
      };
    }
  };
}
