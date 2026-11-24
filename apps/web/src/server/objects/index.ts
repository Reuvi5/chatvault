/**
 * Picking the drivers for the two independent copies, and the failure switch
 * the disaster drill uses to make the primary unreachable on purpose.
 */
import { getEnv, type ProviderConfig } from '../env';
import { ObjectStoreError, type ObjectDriver } from './driver';
import { LocalObjectDriver } from './localDriver';
import { S3ObjectDriver } from './s3Driver';

function build(config: ProviderConfig): ObjectDriver {
  if (config.kind === 'local') {
    if (!config.directory) throw new Error(`${config.label}: a directory is required`);
    return new LocalObjectDriver(
      config.label,
      config.directory,
      config.partSizeBytes,
      config.latencyMs,
    );
  }
  const missing = (['bucket', 'accessKeyId', 'secretAccessKey'] as const).filter(
    (key) => !config[key],
  );
  if (missing.length > 0) {
    throw new Error(`${config.label}: missing ${missing.join(', ')} for the S3 driver`);
  }
  return new S3ObjectDriver({
    label: config.label,
    bucket: config.bucket as string,
    region: config.region ?? 'auto',
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    accessKeyId: config.accessKeyId as string,
    secretAccessKey: config.secretAccessKey as string,
    partSizeBytes: config.partSizeBytes,
  });
}

/** A driver that refuses every call, for the "primary is down" drill. */
class UnavailableDriver implements ObjectDriver {
  readonly kind: 'local' | 's3';
  readonly partSizeBytes: number;

  constructor(
    readonly label: string,
    readonly location: string,
    kind: 'local' | 's3',
    partSizeBytes: number,
  ) {
    this.kind = kind;
    this.partSizeBytes = partSizeBytes;
  }

  private fail(): never {
    throw new ObjectStoreError(`${this.label} is unreachable (simulated outage)`, 'unavailable');
  }

  async beginUpload(): Promise<{ uploadId: string | null }> {
    this.fail();
  }
  async uploadPart(): Promise<{ etag: string | null }> {
    this.fail();
  }
  async completeUpload(): Promise<never> {
    this.fail();
  }
  async abortUpload(): Promise<void> {
    /* nothing to abort */
  }
  async put(): Promise<never> {
    this.fail();
  }
  async get(): Promise<never> {
    this.fail();
  }
  async getWebStream(): Promise<never> {
    this.fail();
  }
  async head(): Promise<never> {
    this.fail();
  }
  async remove(): Promise<void> {
    this.fail();
  }
  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: false, detail: `${this.label}: simulated outage` };
  }
}

let primary: ObjectDriver | null = null;
let secondary: ObjectDriver | null | undefined;

export function getPrimaryDriver(): ObjectDriver {
  const env = getEnv();
  if (!primary) {
    const real = build(env.primary);
    primary = env.simulatePrimaryDown
      ? new UnavailableDriver(real.label, real.location, real.kind, real.partSizeBytes)
      : real;
  }
  return primary;
}

export function getSecondaryDriver(): ObjectDriver | null {
  const env = getEnv();
  if (secondary === undefined) secondary = env.secondary ? build(env.secondary) : null;
  return secondary;
}

/** Ordered list of places an object may be read from. */
export function readOrder(): Array<{ driver: ObjectDriver; role: 'primary' | 'secondary' }> {
  const out: Array<{ driver: ObjectDriver; role: 'primary' | 'secondary' }> = [
    { driver: getPrimaryDriver(), role: 'primary' },
  ];
  const backup = getSecondaryDriver();
  if (backup) out.push({ driver: backup, role: 'secondary' });
  return out;
}

export function resetDriversForTests(): void {
  primary = null;
  secondary = undefined;
}

export { ObjectStoreError } from './driver';
export type { ObjectDriver } from './driver';
