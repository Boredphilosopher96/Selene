import { useEffect, useRef, useState } from 'react';
import type {
  ProjectBackup,
  ProjectRestoreReceipt
} from '../../collaboration-service/src/project-backup-contract';
import {
  decryptProjectBackup,
  encryptProjectBackup,
  encryptedProjectBackupMaxBytes,
  type ProjectRecoveryActions
} from './project-recovery-model';
import './project-recovery-panel.css';

export interface ProjectRecoveryPanelProps {
  readonly projectId: string;
  readonly currentRevisionId: string;
  readonly actions: ProjectRecoveryActions;
  readonly onRestored?: (receipt: ProjectRestoreReceipt) => void;
}
export function ProjectRecoveryPanel({
  projectId,
  currentRevisionId,
  actions,
  onRestored
}: ProjectRecoveryPanelProps) {
  const [passphrase, setPassphrase] = useState('');
  const [retentionDays, setRetentionDays] = useState(30);
  const [backup, setBackup] = useState<ProjectBackup | undefined>();
  const [receipt, setReceipt] = useState<ProjectRestoreReceipt | undefined>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Backup and restore require owner or admin access.');
  const latch = useRef(false);
  const mounted = useRef(true);
  const operationId = useRef(0);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  useEffect(() => {
    mounted.current = true;
    operationId.current += 1;
    latch.current = false;
    setPassphrase('');
    setBackup(undefined);
    setReceipt(undefined);
    setBusy(false);
    setStatus('Backup and restore require owner or admin access.');
    return () => {
      mounted.current = false;
      operationId.current += 1;
    };
  }, [projectId]);
  const current = (ownerProject: string) => mounted.current && projectRef.current === ownerProject;
  const operation = async (task: () => Promise<void>) => {
    if (latch.current) return;
    latch.current = true;
    setBusy(true);
    const token = ++operationId.current;
    try {
      await task();
    } catch (error) {
      if (mounted.current && token === operationId.current)
        setStatus(error instanceof Error ? error.message : 'Project recovery failed.');
    } finally {
      if (mounted.current && token === operationId.current) {
        latch.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <section className="project-recovery-panel" aria-labelledby="project-recovery-heading">
      <h2 id="project-recovery-heading">Project backup and recovery</h2>
      <p>
        Project {projectId}; current revision {currentRevisionId}.
      </p>
      <label>
        Backup passphrase
        <input
          type="password"
          autoComplete="new-password"
          value={passphrase}
          disabled={busy}
          onChange={(event) => setPassphrase(event.currentTarget.value)}
        />
      </label>
      <label>
        Retention days
        <input
          type="number"
          min={1}
          max={365}
          value={retentionDays}
          disabled={busy}
          onChange={(event) => setRetentionDays(Number(event.currentTarget.value))}
        />
      </label>
      <button
        type="button"
        disabled={
          busy ||
          passphrase.length < 12 ||
          !Number.isInteger(retentionDays) ||
          retentionDays < 1 ||
          retentionDays > 365
        }
        onClick={() =>
          void operation(async () => {
            const ownerProject = projectId;
            const exported = await actions.backup(ownerProject, retentionDays);
            const encrypted = await encryptProjectBackup(exported, passphrase);
            if (!current(ownerProject)) return;
            const url = URL.createObjectURL(new Blob([encrypted], { type: 'application/json' }));
            try {
              const link = document.createElement('a');
              link.href = url;
              link.download = `${ownerProject}-${exported.document.latestRevisionId}.selene-backup.json`;
              link.click();
            } finally {
              URL.revokeObjectURL(url);
            }
            setBackup(exported);
            setReceipt(undefined);
            setPassphrase('');
            setStatus(
              'Encrypted backup downloaded. Keep its passphrase separately; expired backups cannot be restored.'
            );
          })
        }
      >
        Download encrypted backup
      </button>
      <label>
        Inspect encrypted backup
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy || passphrase.length < 12}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file === undefined) return;
            const ownerProject = projectId;
            void operation(async () => {
              if (file.size > encryptedProjectBackupMaxBytes)
                throw new Error('Encrypted backup exceeds the supported size.');
              const inspected = await decryptProjectBackup(await file.text(), passphrase);
              if (!current(ownerProject)) return;
              if (inspected.document.projectId !== ownerProject)
                throw new Error('This backup belongs to another project.');
              setBackup(inspected);
              setReceipt(undefined);
              setPassphrase('');
              setStatus(
                'Backup checksum verified. Inspect its identity and scope before restoring.'
              );
            });
          }}
        />
      </label>
      {backup?.document.projectId === projectId ? (
        <>
          <dl>
            <dt>Tenant</dt>
            <dd>{backup.document.tenantId}</dd>
            <dt>Backed-up revision</dt>
            <dd>{backup.document.latestRevisionId}</dd>
            <dt>Restore owner</dt>
            <dd>{backup.document.restoreOwnerId}</dd>
            <dt>Retention expiry</dt>
            <dd>{backup.document.expiresAt}</dd>
            <dt>Checksum</dt>
            <dd>
              <code>{backup.sha256}</code>
            </dd>
            <dt>Project scope</dt>
            <dd>
              {backup.document.snapshot.revisions.length} revisions,{' '}
              {backup.document.snapshot.comments.length} comments,{' '}
              {backup.document.snapshot.reviewThreads.length} review threads,{' '}
              {backup.document.audits.length} project-resource audit events.
            </dd>
          </dl>
          <p>Excluded from this project backup:</p>
          <ul>
            {backup.document.exclusions.map((exclusion) => (
              <li key={exclusion}>{exclusion}</li>
            ))}
          </ul>
          <button
            type="button"
            disabled={busy || Date.parse(backup.document.expiresAt) <= Date.now()}
            onClick={() =>
              void operation(async () => {
                const ownerProject = projectId;
                const restored = await actions.restore(backup, currentRevisionId);
                if (!current(ownerProject)) return;
                setReceipt(restored);
                setStatus(
                  `Restored ${restored.restoredRevisionId}; previous revision ${restored.previousRevisionId}.`
                );
                onRestored?.(restored);
              })
            }
          >
            Restore backup over {currentRevisionId}
          </button>
        </>
      ) : null}
      {receipt?.projectId === projectId ? (
        <p>
          Verified restore audit: {receipt.restoreAuditId}; preserved audit identities:{' '}
          {receipt.preservedAuditIds.join(', ') || 'None in this backup'}.
        </p>
      ) : null}
      <p role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
