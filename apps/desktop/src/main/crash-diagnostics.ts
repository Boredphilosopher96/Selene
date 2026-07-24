import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CRASH_DIAGNOSTICS_VERSION = 'selene-crash-diagnostics/v1' as const;
export const DEFAULT_MAX_DIAGNOSTIC_EVENTS = 32;
export const DEFAULT_DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEFAULT_MAX_CONSENT_HISTORY = 16;
export const DEFAULT_DIAGNOSTICS_RETRY_MS = 60 * 1_000;
export const DEFAULT_MAX_DIAGNOSTICS_RETRY_MS = 60 * 60 * 1_000;
export const DEFAULT_CRASH_LOOP_LIMIT = 3;
export const DEFAULT_CRASH_LOOP_WINDOW_MS = 5 * 60 * 1_000;

export type DiagnosticSource = 'electron' | 'preview' | 'agent' | 'service';
export type DiagnosticCategory =
  | 'uncaught-exception'
  | 'unhandled-rejection'
  | 'renderer-gone'
  | 'child-process-gone'
  | 'runtime-error'
  | 'adapter-failure'
  | 'operation-failure';

/** This schema intentionally has no error text, stack, identifier, or arbitrary metadata fields. */
export interface CrashDiagnosticEvent {
  readonly source: DiagnosticSource;
  readonly category: DiagnosticCategory;
  readonly occurredAt: string;
}

export interface CrashDiagnosticsExport {
  readonly format: typeof CRASH_DIAGNOSTICS_VERSION;
  readonly exportedAt: string;
  readonly events: readonly CrashDiagnosticEvent[];
}

export interface DiagnosticsReportingAdapter {
  /** An operator supplies this opt-in port; diagnostics never create network clients themselves. */
  report(
    bundle: CrashDiagnosticsExport,
    delivery: { readonly idempotencyKey: string; readonly signal: AbortSignal }
  ): Promise<void>;
}

/** Encryption belongs to trusted runtime composition (for example Electron safeStorage). */
export interface DiagnosticsStorageCodec {
  seal(plaintext: string): string;
  open(ciphertext: string): string;
}

/** Main-process policy is supplied by trusted application composition, never by the renderer. */
export interface DiagnosticsPolicy {
  readonly collection: 'allow' | 'deny';
  readonly reporting: 'allow' | 'deny';
}

export interface DiagnosticsConsent {
  readonly user: 'unknown' | 'granted' | 'denied';
  readonly organization: 'allow' | 'deny' | 'not-managed';
  readonly history: readonly DiagnosticsConsentHistoryEntry[];
}

/** Contains only the choice and timestamp; it deliberately has no person, account, or device ID. */
export interface DiagnosticsConsentHistoryEntry {
  readonly user: 'granted' | 'denied';
  readonly recordedAt: string;
}

export interface CrashDiagnosticsStore {
  load(): Promise<unknown>;
  save(events: readonly CrashDiagnosticEvent[]): Promise<void>;
  delete(): Promise<void>;
}

export interface CrashLoopStore {
  load(): Promise<unknown>;
  save(startedAt: readonly number[]): Promise<void>;
  delete(): Promise<void>;
}

export interface DiagnosticsConsentStore {
  load(): Promise<unknown>;
  save(consent: DiagnosticsConsent): Promise<void>;
  delete(): Promise<void>;
}

export interface DiagnosticsDeliveryStore {
  load(): Promise<unknown>;
  save(state: DiagnosticsDeliveryState): Promise<void>;
  delete(): Promise<void>;
}

export interface DiagnosticsDeliveryState {
  readonly pending?: {
    readonly fingerprint: string;
    /** The exact safe support bundle identified by fingerprint; retries must never rebuild it. */
    readonly bundle: CrashDiagnosticsExport;
    readonly attempts: number;
    readonly nextAttemptAt: number;
  };
  readonly delivered?: {
    readonly fingerprint: string;
    readonly deliveredAt: string;
  };
}

export interface CrashRecoveryStatus {
  readonly active: boolean;
  readonly attempts: number;
}

export interface CrashDiagnosticSink {
  capture(source: DiagnosticSource, category: DiagnosticCategory, hostile?: unknown): Promise<void>;
}

const sources = new Set<DiagnosticSource>(['electron', 'preview', 'agent', 'service']);
const categories = new Set<DiagnosticCategory>([
  'uncaught-exception',
  'unhandled-rejection',
  'renderer-gone',
  'child-process-gone',
  'runtime-error',
  'adapter-failure',
  'operation-failure'
]);
const MAX_PERSISTED_ARRAY_ITEMS = 256;

/**
 * Persisted files are attacker-controlled at the filesystem boundary. Trim before mapping or
 * filtering so a syntactically valid but enormous JSON array cannot consume unbounded CPU.
 */
function boundedArrayTail(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || !Number.isSafeInteger(maximum) || maximum < 1) return [];
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length =
      lengthDescriptor !== undefined && 'value' in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
    if (!Number.isSafeInteger(length) || length < 0) return [];
    const count = Math.min(maximum, MAX_PERSISTED_ARRAY_ITEMS, length);
    const start = length - count;
    const result: unknown[] = [];
    for (let index = start; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor !== undefined && 'value' in descriptor) result.push(descriptor.value);
    }
    return result;
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Persisted JSON is untrusted. Reading only own data descriptors prevents a getter or inherited
 * property from executing while the parser is deciding whether a record is safe to retain.
 */
function dataField(value: Record<string, unknown>, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

type CapturedMethod = { readonly target: object; readonly method: (...args: unknown[]) => unknown };

/** Capture a data method without invoking getters or creating a mutable bound function. */
function captureMethod(value: unknown, name: string): CapturedMethod | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null)
    return undefined;
  let current: object | null = value as object;
  try {
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, name);
      if (descriptor !== undefined) {
        if (!('value' in descriptor) || typeof descriptor.value !== 'function') return undefined;
        return {
          target: value as object,
          method: descriptor.value as (...args: unknown[]) => unknown
        };
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function validEvent(value: unknown): CrashDiagnosticEvent | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const source = dataField(value, 'source');
    const category = dataField(value, 'category');
    const occurredAt = dataField(value, 'occurredAt');
    if (
      typeof source !== 'string' ||
      !sources.has(source as DiagnosticSource) ||
      typeof category !== 'string' ||
      !categories.has(category as DiagnosticCategory) ||
      typeof occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(occurredAt))
    )
      return undefined;
    return {
      source: source as DiagnosticSource,
      category: category as DiagnosticCategory,
      occurredAt
    };
  } catch {
    return undefined;
  }
}

function validConsentHistory(value: unknown): DiagnosticsConsentHistoryEntry | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const user = dataField(value, 'user');
    const recordedAt = dataField(value, 'recordedAt');
    if (
      (user !== 'granted' && user !== 'denied') ||
      typeof recordedAt !== 'string' ||
      !Number.isFinite(Date.parse(recordedAt))
    )
      return undefined;
    return { user, recordedAt };
  } catch {
    return undefined;
  }
}

export function parseDiagnosticsConsent(value: unknown): DiagnosticsConsent {
  try {
    if (!isRecord(value)) return { user: 'unknown', organization: 'not-managed', history: [] };
    const storedUser = dataField(value, 'user');
    const storedOrganization = dataField(value, 'organization');
    const storedHistory = dataField(value, 'history');
    const user =
      storedUser === 'granted' || storedUser === 'denied' || storedUser === 'unknown'
        ? storedUser
        : 'unknown';
    const organization =
      storedOrganization === 'allow' ||
      storedOrganization === 'deny' ||
      storedOrganization === 'not-managed'
        ? storedOrganization
        : 'not-managed';
    const history = Array.isArray(storedHistory)
      ? boundedArrayTail(storedHistory, DEFAULT_MAX_CONSENT_HISTORY)
          .map(validConsentHistory)
          .filter((entry): entry is DiagnosticsConsentHistoryEntry => entry !== undefined)
          .slice(-DEFAULT_MAX_CONSENT_HISTORY)
      : [];
    return { user, organization, history };
  } catch {
    return { user: 'unknown', organization: 'not-managed', history: [] };
  }
}

export function parseDiagnosticsDeliveryState(value: unknown): DiagnosticsDeliveryState {
  try {
    if (!isRecord(value)) return {};
    const pendingValue = dataField(value, 'pending');
    const deliveredValue = dataField(value, 'delivered');
    const parseFingerprint = (entry: unknown) => {
      if (!isRecord(entry)) return undefined;
      const fingerprint = dataField(entry, 'fingerprint');
      if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) return undefined;
      return fingerprint;
    };
    const pendingFingerprint = parseFingerprint(pendingValue);
    const deliveredFingerprint = parseFingerprint(deliveredValue);
    const pendingAttempts = isRecord(pendingValue)
      ? dataField(pendingValue, 'attempts')
      : undefined;
    const pendingNextAttemptAt = isRecord(pendingValue)
      ? dataField(pendingValue, 'nextAttemptAt')
      : undefined;
    const pendingBundle = isRecord(pendingValue)
      ? parseFrozenBundle(dataField(pendingValue, 'bundle'))
      : undefined;
    const pending =
      pendingFingerprint !== undefined &&
      pendingBundle !== undefined &&
      pendingFingerprint === fingerprintBundle(pendingBundle) &&
      isRecord(pendingValue) &&
      typeof pendingAttempts === 'number' &&
      Number.isSafeInteger(pendingAttempts) &&
      pendingAttempts >= 1 &&
      pendingAttempts <= 64 &&
      typeof pendingNextAttemptAt === 'number' &&
      Number.isSafeInteger(pendingNextAttemptAt) &&
      pendingNextAttemptAt >= 0
        ? {
            fingerprint: pendingFingerprint,
            bundle: pendingBundle,
            attempts: pendingAttempts,
            nextAttemptAt: pendingNextAttemptAt
          }
        : undefined;
    const delivered =
      deliveredFingerprint !== undefined &&
      isRecord(deliveredValue) &&
      typeof dataField(deliveredValue, 'deliveredAt') === 'string' &&
      Number.isFinite(Date.parse(dataField(deliveredValue, 'deliveredAt') as string))
        ? {
            fingerprint: deliveredFingerprint,
            deliveredAt: dataField(deliveredValue, 'deliveredAt') as string
          }
        : undefined;
    return { ...(pending ? { pending } : {}), ...(delivered ? { delivered } : {}) };
  } catch {
    return {};
  }
}

/** Ignores malformed or hostile persisted content instead of surfacing it as a diagnostic payload. */
export function parseCrashDiagnostics(
  value: unknown,
  maximum = DEFAULT_MAX_DIAGNOSTIC_EVENTS
): CrashDiagnosticEvent[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256)
    throw new Error('diagnostic queue limit must be between 1 and 256');
  if (!Array.isArray(value)) return [];
  const events: CrashDiagnosticEvent[] = [];
  try {
    for (const item of boundedArrayTail(value, maximum)) {
      const event = validEvent(item);
      if (event !== undefined) events.push(event);
    }
  } catch {
    return events.slice(-maximum);
  }
  return events.slice(-maximum);
}

function retains(event: CrashDiagnosticEvent, now: number, retentionMs: number): boolean {
  const occurredAt = Date.parse(event.occurredAt);
  return occurredAt <= now && occurredAt >= now - retentionMs;
}

function safeStartupTimes(value: unknown, maximum: number): number[] {
  return boundedArrayTail(value, maximum).filter(
    (item): item is number => typeof item === 'number' && Number.isSafeInteger(item)
  );
}

function fingerprintBundle(bundle: CrashDiagnosticsExport): string {
  return createHash('sha256').update(JSON.stringify(bundle)).digest('hex');
}

/** The reporter receives a separate, deeply frozen copy and can never mutate durable retry state. */
function freezeBundle(bundle: CrashDiagnosticsExport): CrashDiagnosticsExport {
  return Object.freeze({
    format: CRASH_DIAGNOSTICS_VERSION,
    exportedAt: bundle.exportedAt,
    events: Object.freeze(bundle.events.map((event) => Object.freeze({ ...event })))
  });
}

function parseFrozenBundle(value: unknown): CrashDiagnosticsExport | undefined {
  try {
    if (
      !isRecord(value) ||
      dataField(value, 'format') !== CRASH_DIAGNOSTICS_VERSION ||
      typeof dataField(value, 'exportedAt') !== 'string' ||
      !Number.isFinite(Date.parse(dataField(value, 'exportedAt') as string)) ||
      !Array.isArray(dataField(value, 'events')) ||
      (dataField(value, 'events') as unknown[]).length > DEFAULT_MAX_DIAGNOSTIC_EVENTS
    )
      return undefined;
    const exportedAt = dataField(value, 'exportedAt') as string;
    const persistedEvents = dataField(value, 'events') as unknown[];
    const events = parseCrashDiagnostics(persistedEvents, DEFAULT_MAX_DIAGNOSTIC_EVENTS);
    if (events.length !== persistedEvents.length) return undefined;
    return freezeBundle({ format: CRASH_DIAGNOSTICS_VERSION, exportedAt, events });
  } catch {
    return undefined;
  }
}

function boundedUtf8(value: unknown, maximumBytes: number, label: string): string {
  if (typeof value !== 'string' || value.length > maximumBytes)
    throw new Error(`${label} exceeds its bounded diagnostics storage limit`);
  if (Buffer.byteLength(value, 'utf8') > maximumBytes)
    throw new Error(`${label} exceeds its bounded diagnostics storage limit`);
  return value;
}

async function assertPrivateParent(parent: string, create: boolean): Promise<void> {
  if (create) await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
    throw new Error('diagnostics private storage parent is unsafe');
  if ((parentStat.mode & 0o077) !== 0) await chmod(parent, 0o700);
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  if (uid !== undefined && parentStat.uid !== uid)
    throw new Error('diagnostics storage owner is unsafe');
  if (gid !== undefined && parentStat.gid !== gid)
    throw new Error('diagnostics storage group is unsafe');
}

async function syncPrivateParent(parent: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writePrivateJson(
  file: string,
  serialized: string,
  maximumBytes: number,
  codec?: DiagnosticsStorageCodec
): Promise<void> {
  const plaintext = boundedUtf8(serialized, maximumBytes, 'diagnostics plaintext');
  const payload = boundedUtf8(
    codec === undefined ? plaintext : codec.seal(plaintext),
    maximumBytes,
    'diagnostics codec output'
  );
  const parent = dirname(file);
  await assertPrivateParent(parent, true);
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(payload, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
    await syncPrivateParent(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readPrivateJson(
  file: string,
  maximumBytes: number,
  fallback: unknown,
  codec?: DiagnosticsStorageCodec
): Promise<unknown> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await assertPrivateParent(dirname(file), false);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) return fallback;
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
    if (uid !== undefined && fileStat.uid !== uid) return fallback;
    if (gid !== undefined && fileStat.gid !== gid) return fallback;
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkSize = Math.min(16 * 1_024, maximumBytes + 1);
    while (total < maximumBytes + 1) {
      const chunk = Buffer.alloc(Math.min(chunkSize, maximumBytes + 1 - total));
      // The offset must advance after each bounded read; this is intentionally sequential.
      // eslint-disable-next-line no-await-in-loop
      const result = await handle.read(chunk, 0, chunk.length, null);
      if (result.bytesRead === 0) break;
      chunks.push(chunk.subarray(0, result.bytesRead));
      total += result.bytesRead;
    }
    if (total > maximumBytes) return fallback;
    const payload = Buffer.concat(chunks, total).toString('utf8');
    const ciphertext = boundedUtf8(payload, maximumBytes, 'diagnostics ciphertext');
    const plaintext = boundedUtf8(
      codec === undefined ? ciphertext : codec.open(ciphertext),
      maximumBytes,
      'diagnostics codec plaintext'
    );
    return JSON.parse(plaintext) as unknown;
  } catch {
    return fallback;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function deletePrivateJson(file: string): Promise<void> {
  const parent = dirname(file);
  try {
    await assertPrivateParent(parent, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await syncPrivateParent(parent);
}

/** Freeze the callable capability at composition time; later object mutation cannot alter disk IO. */
function bindStorageCodec(
  codec: DiagnosticsStorageCodec | undefined
): DiagnosticsStorageCodec | undefined {
  if (codec === undefined) return undefined;
  const seal = captureMethod(codec, 'seal');
  const openCodec = captureMethod(codec, 'open');
  if (seal === undefined || openCodec === undefined)
    throw new Error('diagnostics storage codec is invalid');
  return Object.freeze({
    seal: (plaintext: string) => Reflect.apply(seal.method, seal.target, [plaintext]) as string,
    open: (ciphertext: string) =>
      Reflect.apply(openCodec.method, openCodec.target, [ciphertext]) as string
  });
}

/** File IO is local only. Its path is never included in exports or reporter calls. */
export class JsonFileDiagnosticsStore implements CrashDiagnosticsStore, CrashLoopStore {
  private readonly codec: DiagnosticsStorageCodec | undefined;

  public constructor(
    private readonly file: string,
    private readonly maximumBytes = 64 * 1_024,
    codec?: DiagnosticsStorageCodec
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1_048_576)
      throw new Error('diagnostics file limit is invalid');
    this.codec = bindStorageCodec(codec);
  }

  public async load(): Promise<unknown> {
    return readPrivateJson(this.file, this.maximumBytes, [], this.codec);
  }

  public async save(value: readonly CrashDiagnosticEvent[] | readonly number[]): Promise<void> {
    const serialized = JSON.stringify(value);
    await writePrivateJson(this.file, serialized, this.maximumBytes, this.codec);
  }

  public async delete(): Promise<void> {
    await deletePrivateJson(this.file);
  }
}

/** Local-only 0600 JSON persistence for a bounded consent audit trail. */
export class JsonFileDiagnosticsConsentStore implements DiagnosticsConsentStore {
  private readonly codec: DiagnosticsStorageCodec | undefined;

  public constructor(
    private readonly file: string,
    private readonly maximumBytes = 16 * 1_024,
    codec?: DiagnosticsStorageCodec
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1_048_576)
      throw new Error('diagnostics consent file limit is invalid');
    this.codec = bindStorageCodec(codec);
  }

  public async load(): Promise<unknown> {
    return readPrivateJson(this.file, this.maximumBytes, {}, this.codec);
  }

  public async save(consent: DiagnosticsConsent): Promise<void> {
    const serialized = JSON.stringify(consent);
    await writePrivateJson(this.file, serialized, this.maximumBytes, this.codec);
  }

  public async delete(): Promise<void> {
    await deletePrivateJson(this.file);
  }
}

/** Durable, private retry metadata. It never stores error text, endpoint details, or credentials. */
export class JsonFileDiagnosticsDeliveryStore implements DiagnosticsDeliveryStore {
  private readonly codec: DiagnosticsStorageCodec | undefined;

  public constructor(
    private readonly file: string,
    private readonly maximumBytes = 4 * 1_024,
    codec?: DiagnosticsStorageCodec
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1_048_576)
      throw new Error('diagnostics delivery file limit is invalid');
    this.codec = bindStorageCodec(codec);
  }

  public async load(): Promise<unknown> {
    return readPrivateJson(this.file, this.maximumBytes, {}, this.codec);
  }

  public async save(state: DiagnosticsDeliveryState): Promise<void> {
    await writePrivateJson(this.file, JSON.stringify(state), this.maximumBytes, this.codec);
  }

  public async delete(): Promise<void> {
    await deletePrivateJson(this.file);
  }
}

class MemoryDiagnosticsConsentStore implements DiagnosticsConsentStore {
  private value: unknown = {};

  public async load(): Promise<unknown> {
    return this.value;
  }

  public async save(consent: DiagnosticsConsent): Promise<void> {
    this.value = structuredClone(consent);
  }

  public async delete(): Promise<void> {
    this.value = {};
  }
}

class MemoryDiagnosticsDeliveryStore implements DiagnosticsDeliveryStore {
  private value: unknown = {};

  public async load(): Promise<unknown> {
    return this.value;
  }

  public async save(state: DiagnosticsDeliveryState): Promise<void> {
    this.value = structuredClone(state);
  }

  public async delete(): Promise<void> {
    this.value = {};
  }
}

/** Store methods are capabilities, not mutable lookup tables after trusted composition. */
function bindDiagnosticsStore(store: CrashDiagnosticsStore): CrashDiagnosticsStore {
  const load = captureMethod(store, 'load');
  const save = captureMethod(store, 'save');
  const remove = captureMethod(store, 'delete');
  if (load === undefined || save === undefined || remove === undefined)
    throw new Error('diagnostics store is invalid');
  return Object.freeze({
    load: () => Reflect.apply(load.method, load.target, []) as Promise<unknown>,
    save: (value: readonly CrashDiagnosticEvent[]) =>
      Reflect.apply(save.method, save.target, [value]) as Promise<void>,
    delete: () => Reflect.apply(remove.method, remove.target, []) as Promise<void>
  });
}

function bindConsentStore(store: DiagnosticsConsentStore): DiagnosticsConsentStore {
  const load = captureMethod(store, 'load');
  const save = captureMethod(store, 'save');
  const remove = captureMethod(store, 'delete');
  if (load === undefined || save === undefined || remove === undefined)
    throw new Error('diagnostics consent store is invalid');
  return Object.freeze({
    load: () => Reflect.apply(load.method, load.target, []) as Promise<unknown>,
    save: (value: DiagnosticsConsent) =>
      Reflect.apply(save.method, save.target, [value]) as Promise<void>,
    delete: () => Reflect.apply(remove.method, remove.target, []) as Promise<void>
  });
}

function bindDeliveryStore(store: DiagnosticsDeliveryStore): DiagnosticsDeliveryStore {
  const load = captureMethod(store, 'load');
  const save = captureMethod(store, 'save');
  const remove = captureMethod(store, 'delete');
  if (load === undefined || save === undefined || remove === undefined)
    throw new Error('diagnostics delivery store is invalid');
  return Object.freeze({
    load: () => Reflect.apply(load.method, load.target, []) as Promise<unknown>,
    save: (value: DiagnosticsDeliveryState) =>
      Reflect.apply(save.method, save.target, [value]) as Promise<void>,
    delete: () => Reflect.apply(remove.method, remove.target, []) as Promise<void>
  });
}

interface CrashDiagnosticsOptions {
  readonly maximumEvents?: number | undefined;
  readonly retentionMs?: number | undefined;
  readonly maximumConsentHistory?: number | undefined;
  readonly organization?: DiagnosticsConsent['organization'] | undefined;
  readonly policy?: DiagnosticsPolicy | undefined;
  readonly deliveryStore?: DiagnosticsDeliveryStore | undefined;
  readonly reportingAdapter?: DiagnosticsReportingAdapter | undefined;
  readonly retryMs?: number | undefined;
  readonly maximumRetryMs?: number | undefined;
  readonly reportTimeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export class CrashDiagnostics implements CrashDiagnosticSink {
  private events: CrashDiagnosticEvent[] = [];
  private consent: DiagnosticsConsent = {
    user: 'unknown',
    organization: 'not-managed',
    history: []
  };
  private delivery: DiagnosticsDeliveryState = {};
  private initialized = false;
  private initialization: Promise<void> | undefined;
  private operation: Promise<void> = Promise.resolve();
  /** Set synchronously when the user opts out so queued or hanging sends fail closed. */
  private withdrawalRequested = false;
  /** A failed erase keeps re-enrollment fail-closed until the same private stores are cleared. */
  private cleanupRequired = false;
  /**
   * The adapter runs outside the state queue. This single admission token quarantines a late or
   * non-cooperative completion so it cannot write delivery state after timeout or withdrawal.
   */
  private activeReporter:
    { readonly token: symbol; readonly controller: AbortController } | undefined;
  private readonly config: Readonly<
    Omit<CrashDiagnosticsOptions, 'now'> & { now?: CapturedMethod | undefined }
  >;
  private readonly store: CrashDiagnosticsStore;
  private readonly consentStore: DiagnosticsConsentStore;

  public constructor(
    store: CrashDiagnosticsStore,
    consentStore: DiagnosticsConsentStore = new MemoryDiagnosticsConsentStore(),
    options: CrashDiagnosticsOptions = {}
  ) {
    // Configuration is a construction-time boundary. Later mutation of an application options
    // object cannot silently widen collection, reporting, retry, or clock behavior.
    this.store = bindDiagnosticsStore(store);
    this.consentStore = bindConsentStore(consentStore);
    const raw = options as unknown as Record<string, unknown>;
    const policyValue = dataField(raw, 'policy');
    const policyRecord = isRecord(policyValue) ? policyValue : undefined;
    const policy =
      policyRecord === undefined
        ? undefined
        : Object.freeze({
            collection: dataField(policyRecord, 'collection') as DiagnosticsPolicy['collection'],
            reporting: dataField(policyRecord, 'reporting') as DiagnosticsPolicy['reporting']
          });
    const nowValue = dataField(raw, 'now');
    const now = nowValue === undefined ? undefined : captureMethod({ now: nowValue }, 'now');
    this.config = Object.freeze({
      maximumEvents: dataField(raw, 'maximumEvents') as number | undefined,
      retentionMs: dataField(raw, 'retentionMs') as number | undefined,
      maximumConsentHistory: dataField(raw, 'maximumConsentHistory') as number | undefined,
      organization: dataField(raw, 'organization') as
        DiagnosticsConsent['organization'] | undefined,
      policy,
      deliveryStore:
        dataField(raw, 'deliveryStore') === undefined
          ? undefined
          : bindDeliveryStore(dataField(raw, 'deliveryStore') as DiagnosticsDeliveryStore),
      reportingAdapter: dataField(raw, 'reportingAdapter') as
        DiagnosticsReportingAdapter | undefined,
      retryMs: dataField(raw, 'retryMs') as number | undefined,
      maximumRetryMs: dataField(raw, 'maximumRetryMs') as number | undefined,
      reportTimeoutMs: dataField(raw, 'reportTimeoutMs') as number | undefined,
      now
    });
  }

  private lastNow = Number.NEGATIVE_INFINITY;

  private currentDate(): Date {
    const value =
      this.config.now === undefined
        ? new Date()
        : Reflect.apply(this.config.now.method, this.config.now.target, []);
    if (!(value instanceof Date)) throw new Error('diagnostics clock is invalid');
    const time = value.getTime();
    if (!Number.isSafeInteger(time) || time < this.lastNow)
      throw new Error('diagnostics clock is invalid');
    this.lastNow = time;
    return new Date(time);
  }

  private get policy(): DiagnosticsPolicy {
    return this.config.policy ?? { collection: 'allow', reporting: 'allow' };
  }

  private get deliveryStore(): DiagnosticsDeliveryStore {
    return (
      this.config.deliveryStore ??
      (this.memoryDeliveryStore ??= new MemoryDiagnosticsDeliveryStore())
    );
  }

  private memoryDeliveryStore: MemoryDiagnosticsDeliveryStore | undefined;

  public async initialize(): Promise<void> {
    if (this.initialization === undefined) {
      const attempt = this.enqueue(() => this.initializeInternal());
      this.initialization = attempt;
      try {
        await attempt;
      } catch (error) {
        if (this.initialization === attempt) this.initialization = undefined;
        throw error;
      }
      return;
    }
    await this.initialization;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  private async initializeInternal(): Promise<void> {
    if (this.initialized) return;
    const now = this.currentDate().getTime();
    const maximumEvents = this.config.maximumEvents ?? DEFAULT_MAX_DIAGNOSTIC_EVENTS;
    const retentionMs = this.config.retentionMs ?? DEFAULT_DIAGNOSTIC_RETENTION_MS;
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 1)
      throw new Error('diagnostic retention must be a positive integer');
    const [storedEvents, storedConsent, storedDelivery] = await Promise.all([
      this.store.load(),
      this.consentStore.load(),
      this.deliveryStore.load()
    ]);
    const parsedEvents = parseCrashDiagnostics(storedEvents, maximumEvents);
    const nextEvents = parsedEvents.filter((event) => retains(event, now, retentionMs));
    let nextConsent = parseDiagnosticsConsent(storedConsent);
    const nextDelivery = parseDiagnosticsDeliveryState(storedDelivery);
    if (this.config.organization !== undefined)
      nextConsent = { ...nextConsent, organization: this.config.organization };
    if (
      this.withdrawalRequested ||
      nextConsent.user !== 'granted' ||
      nextConsent.organization === 'deny' ||
      this.policy.collection === 'deny'
    ) {
      await Promise.all([this.store.delete(), this.deliveryStore.delete()]);
      this.events = [];
      this.delivery = {};
    } else {
      if (nextEvents.length !== parsedEvents.length) await this.store.save(nextEvents);
      this.events = nextEvents;
      this.delivery = nextDelivery;
    }
    this.consent = nextConsent;
    this.initialized = true;
  }

  public async getConsent(): Promise<DiagnosticsConsent> {
    await this.initialize();
    return this.enqueue(async () => structuredClone(this.consent));
  }

  /** This is the sole local opt-in entry point. A denial immediately erases queued events. */
  public async setUserConsent(user: 'granted' | 'denied'): Promise<DiagnosticsConsent> {
    if (user === 'denied') {
      // This cannot wait behind an untrusted reporting port. The in-memory guard is deliberately
      // first: even a disk-full failure must never leave this process collecting or reporting.
      this.withdrawalRequested = true;
      this.events = [];
      this.delivery = {};
      this.activeReporter?.controller.abort();
      this.activeReporter = undefined;
    }
    await this.initialize();
    return this.enqueue(async () => {
      const maximum = this.config.maximumConsentHistory ?? DEFAULT_MAX_CONSENT_HISTORY;
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256)
        throw new Error('consent history limit must be between 1 and 256');
      const nextConsent: DiagnosticsConsent = {
        ...this.consent,
        user,
        history: [
          ...this.consent.history,
          { user, recordedAt: this.currentDate().toISOString() }
        ].slice(-maximum)
      };
      if (user === 'denied') {
        this.consent = nextConsent;
        // Keep the withdrawal latch and empty memory state on every persistence failure.
        await this.consentStore.save(nextConsent);
        try {
          await this.deleteInternal();
          this.cleanupRequired = false;
        } catch (error) {
          this.cleanupRequired = true;
          throw error;
        }
      } else {
        // Do not let a later opt-in resurrect bytes left behind by a failed withdrawal cleanup.
        // Retry the original erase before writing a granted consent record.
        if (this.cleanupRequired) {
          await this.deleteInternal();
          this.cleanupRequired = false;
        }
        await this.consentStore.save(nextConsent);
        this.consent = nextConsent;
        this.withdrawalRequested = false;
      }
      return structuredClone(this.consent);
    });
  }

  /**
   * `hostile` intentionally remains unread. Error messages, stacks, renderer data,
   * agent output, design material, paths, credentials, and raw dumps cannot enter the queue.
   */
  public async capture(
    source: DiagnosticSource,
    category: DiagnosticCategory,
    _hostile?: unknown
  ): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      if (!sources.has(source) || !categories.has(category))
        throw new Error('invalid diagnostic type');
      if (
        this.withdrawalRequested ||
        this.consent.user !== 'granted' ||
        this.consent.organization === 'deny' ||
        this.policy.collection === 'deny'
      )
        return;
      const maximum = this.config.maximumEvents ?? DEFAULT_MAX_DIAGNOSTIC_EVENTS;
      const nextEvents = [
        ...this.events,
        { source, category, occurredAt: this.currentDate().toISOString() }
      ].slice(-maximum);
      await this.store.save(nextEvents);
      this.events = nextEvents;
    });
  }

  public async export(): Promise<CrashDiagnosticsExport> {
    await this.initialize();
    return this.enqueue(async () => this.supportBundle());
  }

  private supportBundle(): CrashDiagnosticsExport {
    return {
      format: CRASH_DIAGNOSTICS_VERSION,
      exportedAt: this.currentDate().toISOString(),
      events: this.withdrawalRequested ? [] : this.events.map((event) => ({ ...event }))
    };
  }

  /** A reporting payload has a stable timestamp for an unchanged queue, unlike an interactive export. */
  private reportingBundle(): CrashDiagnosticsExport {
    const bundle = this.supportBundle();
    const latestEvent = bundle.events.at(-1);
    return latestEvent === undefined ? bundle : { ...bundle, exportedAt: latestEvent.occurredAt };
  }

  public async delete(): Promise<void> {
    await this.initialize();
    await this.enqueue(() => this.deleteInternal());
  }

  private async deleteInternal(): Promise<void> {
    await Promise.all([this.store.delete(), this.deliveryStore.delete()]);
    this.events = [];
    this.delivery = {};
    this.initialized = true;
  }

  private async invokeReporter(
    adapter: DiagnosticsReportingAdapter,
    bundle: CrashDiagnosticsExport,
    idempotencyKey: string,
    controller: AbortController
  ): Promise<void> {
    const timeoutMs = this.config.reportTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
      throw new Error('diagnostics reporting timeout is invalid');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let removeAbortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('diagnostics reporting port was aborted'));
        controller.signal.addEventListener('abort', abort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener('abort', abort);
        if (controller.signal.aborted) abort();
      });
      await Promise.race([
        Promise.resolve().then(() =>
          adapter.report(freezeBundle(bundle), { idempotencyKey, signal: controller.signal })
        ),
        aborted,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('diagnostics reporting port timed out'));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      removeAbortListener?.();
    }
  }

  /**
   * A trusted main-process integration may call this. It never starts a network operation itself,
   * keeps failed bundles locally for bounded retry, and suppresses duplicate successful deliveries.
   */
  public async report(adapter = this.config.reportingAdapter): Promise<boolean> {
    await this.initialize();
    const admission = await this.enqueue(async () => {
      if (
        this.withdrawalRequested ||
        this.consent.user !== 'granted' ||
        (this.consent.organization !== 'allow' && this.consent.organization !== 'not-managed') ||
        this.policy.reporting === 'deny' ||
        adapter === undefined
      )
        return undefined;
      // A port may ignore AbortSignal forever. It gets one bounded admission and is then
      // quarantined by its token; capture, export, delete, consent, and later admissions proceed.
      if (this.activeReporter !== undefined) return undefined;
      // Read and bind exactly once while admitted. A mutable integration object cannot swap the
      // method after its retry record has been persisted or during the async hand-off.
      const capturedReport = captureMethod(adapter, 'report');
      if (capturedReport === undefined) return undefined;
      const admittedAdapter: DiagnosticsReportingAdapter = Object.freeze({
        report: (
          bundle: CrashDiagnosticsExport,
          delivery: { readonly idempotencyKey: string; readonly signal: AbortSignal }
        ) =>
          Reflect.apply(capturedReport.method, capturedReport.target, [
            bundle,
            delivery
          ]) as Promise<void>
      });
      const now = this.currentDate().getTime();
      const existing = this.delivery.pending;
      if (existing !== undefined && existing.nextAttemptAt > now) return undefined;
      const bundle = freezeBundle(existing?.bundle ?? this.reportingBundle());
      if (bundle.events.length === 0) return undefined;
      const fingerprint = existing?.fingerprint ?? fingerprintBundle(bundle);
      if (existing === undefined && this.delivery.delivered?.fingerprint === fingerprint)
        return true;
      const attempts = existing?.attempts === undefined ? 1 : existing.attempts + 1;
      const base = this.config.retryMs ?? DEFAULT_DIAGNOSTICS_RETRY_MS;
      const maximum = this.config.maximumRetryMs ?? DEFAULT_MAX_DIAGNOSTICS_RETRY_MS;
      if (
        !Number.isSafeInteger(base) ||
        base < 1 ||
        !Number.isSafeInteger(maximum) ||
        maximum < base
      )
        throw new Error('diagnostics retry configuration is invalid');
      const pending: DiagnosticsDeliveryState = {
        pending: {
          fingerprint,
          bundle,
          attempts: Math.min(attempts, 64),
          nextAttemptAt: now + Math.min(base * 2 ** Math.min(attempts - 1, 20), maximum)
        }
      };
      // Persist before touching the port so a crash or timeout retries with this same key.
      await this.deliveryStore.save(pending);
      this.delivery = pending;
      const reporter = { token: Symbol('diagnostics reporter'), controller: new AbortController() };
      this.activeReporter = reporter;
      return { adapter: admittedAdapter, bundle, fingerprint, now, reporter };
    });
    if (admission === undefined) return false;
    if (admission === true) return true;
    let delivered = false;
    try {
      await this.invokeReporter(
        admission.adapter,
        admission.bundle,
        admission.fingerprint,
        admission.reporter.controller
      );
      delivered = true;
    } catch {
      // The retry record was committed during admission. Timeout, abort, throw, and rejection all
      // leave exactly that bounded record for a later, independent admission.
    }
    return this.enqueue(async () => {
      if (this.activeReporter?.token !== admission.reporter.token) return false;
      this.activeReporter = undefined;
      if (
        !delivered ||
        this.withdrawalRequested ||
        this.consent.user !== 'granted' ||
        this.consent.organization === 'deny' ||
        this.policy.reporting === 'deny'
      )
        return false;
      const deliveredState: DiagnosticsDeliveryState = {
        delivered: {
          fingerprint: admission.fingerprint,
          deliveredAt: new Date(admission.now).toISOString()
        }
      };
      await this.deliveryStore.save(deliveredState);
      this.delivery = deliveredState;
      return true;
    });
  }
}

export class CrashLoopRecovery {
  private active = false;
  private uncleanTermination = false;
  private attempts = 0;
  private operation: Promise<void> = Promise.resolve();
  private lastNow = Number.NEGATIVE_INFINITY;
  private readonly store: CrashLoopStore;
  private readonly limit: number | undefined;
  private readonly windowMs: number | undefined;
  private readonly now: CapturedMethod | undefined;

  public constructor(
    store: CrashLoopStore,
    options: {
      readonly limit?: number;
      readonly windowMs?: number;
      readonly now?: () => number;
    } = {}
  ) {
    const load = captureMethod(store, 'load');
    const save = captureMethod(store, 'save');
    const remove = captureMethod(store, 'delete');
    if (load === undefined || save === undefined || remove === undefined)
      throw new Error('crash-loop store is invalid');
    this.store = Object.freeze({
      load: () => Reflect.apply(load.method, load.target, []) as Promise<unknown>,
      save: (value: readonly number[]) =>
        Reflect.apply(save.method, save.target, [value]) as Promise<void>,
      delete: () => Reflect.apply(remove.method, remove.target, []) as Promise<void>
    });
    const raw = options as unknown as Record<string, unknown>;
    this.limit = dataField(raw, 'limit') as number | undefined;
    this.windowMs = dataField(raw, 'windowMs') as number | undefined;
    const nowValue = dataField(raw, 'now');
    this.now = nowValue === undefined ? undefined : captureMethod({ now: nowValue }, 'now');
    if (nowValue !== undefined && this.now === undefined)
      throw new Error('crash-loop clock is invalid');
  }

  private currentNow(): number {
    const value =
      this.now === undefined ? Date.now() : Reflect.apply(this.now.method, this.now.target, []);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < this.lastNow)
      throw new Error('crash-loop clock is invalid');
    this.lastNow = value;
    return value;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operation.then(operation, operation);
    this.operation = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /** Records bounded startup timestamps and enters safe mode only after a repeat crash pattern. */
  public beginStartup(): Promise<CrashRecoveryStatus> {
    return this.enqueue(async () => {
      const limit = this.limit ?? DEFAULT_CRASH_LOOP_LIMIT;
      const windowMs = this.windowMs ?? DEFAULT_CRASH_LOOP_WINDOW_MS;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 2 ||
        !Number.isSafeInteger(windowMs) ||
        windowMs < 1
      )
        throw new Error('crash-loop recovery configuration is invalid');
      const now = this.currentNow();
      const starts = safeStartupTimes(await this.store.load(), Math.max(1, limit - 1)).filter(
        (time) => time >= now - windowMs
      );
      starts.push(now);
      const nextStarts = starts.slice(-limit);
      await this.store.save(nextStarts);
      this.attempts = nextStarts.length;
      this.active = nextStarts.length >= limit;
      this.uncleanTermination = false;
      return { active: this.active, attempts: this.attempts };
    });
  }

  /** Call before capturing a fatal main/renderer process termination. */
  public markUncleanTermination(): void {
    this.uncleanTermination = true;
  }

  public status(): CrashRecoveryStatus {
    return { active: this.active, attempts: this.attempts };
  }

  /** Only a known-clean lifecycle may clear crash-loop evidence. */
  public cleanShutdown(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.uncleanTermination) return false;
      await this.store.delete();
      this.attempts = 0;
      this.active = false;
      return true;
    });
  }

  /** A user-visible, explicit recovery action clears the loop marker. */
  public reset(): Promise<void> {
    return this.enqueue(async () => {
      await this.store.delete();
      this.active = false;
      this.attempts = 0;
      this.uncleanTermination = false;
    });
  }
}
