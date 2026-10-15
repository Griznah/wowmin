import type {
  BackendConnectionStatus,
  ManagedServiceName,
  ManagedServicePhase,
  ManagedServiceStatus,
} from './types/api';

export interface ManagedConnector {
  connected(): boolean;
  check?(): Promise<boolean>;
  connect(): Promise<{ success: boolean; message?: string }>;
  disconnect(): Promise<void>;
}

export interface ManagedConnectionLifecycleOptions {
  initialRetryMs?: number;
  maximumRetryMs?: number;
  healthCheckMs?: number;
  onTransition?: (service: ManagedServiceName, previous: ManagedServicePhase, current: ManagedServiceStatus) => void;
}

const SERVICE_NAMES: ManagedServiceName[] = [
  'soap',
  'worldDatabase',
  'mapDatabase',
  'economyDatabase',
];

function initialServiceStatus(): ManagedServiceStatus {
  return { phase: 'disconnected', error: null, retryAt: null };
}

export class ManagedConnectionLifecycle {
  private readonly initialRetryMs: number;
  private readonly maximumRetryMs: number;
  private readonly healthCheckMs: number;
  private readonly statuses: Record<ManagedServiceName, ManagedServiceStatus>;
  private retryDelayMs: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionAttempt: Promise<BackendConnectionStatus> | null = null;
  private stopped = true;
  private updatedAt = Date.now();

  constructor(
    private readonly connectors: Record<ManagedServiceName, ManagedConnector>,
    private readonly options: ManagedConnectionLifecycleOptions = {},
  ) {
    this.initialRetryMs = Math.max(1000, options.initialRetryMs ?? 5000);
    this.maximumRetryMs = Math.max(this.initialRetryMs, options.maximumRetryMs ?? 60000);
    this.healthCheckMs = Math.max(5000, options.healthCheckMs ?? 30000);
    this.retryDelayMs = this.initialRetryMs;
    this.statuses = {
      soap: initialServiceStatus(),
      worldDatabase: initialServiceStatus(),
      mapDatabase: initialServiceStatus(),
      economyDatabase: initialServiceStatus(),
    };
  }

  start(): Promise<BackendConnectionStatus> {
    this.stopped = false;
    return this.ensureConnected();
  }

  ensureConnected(): Promise<BackendConnectionStatus> {
    if (this.connectionAttempt) return this.connectionAttempt;
    this.clearRetryTimer();
    this.connectionAttempt = this.connectServices().finally(() => {
      this.connectionAttempt = null;
    });
    return this.connectionAttempt;
  }

  snapshot(): BackendConnectionStatus {
    return {
      managed: true,
      updatedAt: this.updatedAt,
      services: {
        soap: { ...this.statuses.soap },
        worldDatabase: { ...this.statuses.worldDatabase },
        mapDatabase: { ...this.statuses.mapDatabase },
        economyDatabase: { ...this.statuses.economyDatabase },
      },
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearRetryTimer();
    if (this.connectionAttempt) await this.connectionAttempt.catch(() => undefined);
    await Promise.allSettled(SERVICE_NAMES.map(async (service) => {
      await this.connectors[service].disconnect();
      this.transition(service, { phase: 'disconnected', error: null, retryAt: null });
    }));
  }

  private async connectServices(): Promise<BackendConnectionStatus> {
    await Promise.all(SERVICE_NAMES.map(async (service) => {
      const connector = this.connectors[service];
      if (connector.connected()) {
        let healthy = true;
        try {
          healthy = !connector.check || await connector.check();
        } catch {
          healthy = false;
        }
        if (healthy) {
          this.transition(service, { phase: 'connected', error: null, retryAt: null });
          return;
        }
        await connector.disconnect().catch(() => undefined);
      }

      this.transition(service, { phase: 'connecting', error: null, retryAt: null });
      try {
        const result = await connector.connect();
        this.transition(service, result.success
          ? { phase: 'connected', error: null, retryAt: null }
          : { phase: 'degraded', error: result.message || 'Connection failed', retryAt: null });
      } catch (error) {
        this.transition(service, {
          phase: 'degraded',
          error: error instanceof Error ? error.message : String(error),
          retryAt: null,
        });
      }
    }));

    if (SERVICE_NAMES.every((service) => this.statuses[service].phase === 'connected')) {
      this.retryDelayMs = this.initialRetryMs;
      if (!this.stopped) this.scheduleHealthCheck();
    } else if (!this.stopped) {
      this.scheduleRetry();
    }
    return this.snapshot();
  }

  private scheduleHealthCheck(): void {
    this.retryTimer = setTimeout(() => void this.ensureConnected(), this.healthCheckMs);
    this.retryTimer.unref();
  }

  private scheduleRetry(): void {
    const retryAt = Date.now() + this.retryDelayMs;
    for (const service of SERVICE_NAMES) {
      if (this.statuses[service].phase === 'degraded') {
        this.statuses[service] = { ...this.statuses[service], retryAt };
      }
    }
    this.updatedAt = Date.now();
    this.retryTimer = setTimeout(() => void this.ensureConnected(), this.retryDelayMs);
    this.retryTimer.unref();
    this.retryDelayMs = Math.min(this.maximumRetryMs, this.retryDelayMs * 2);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private transition(service: ManagedServiceName, status: ManagedServiceStatus): void {
    const previousStatus = this.statuses[service];
    this.statuses[service] = status;
    this.updatedAt = Date.now();
    if (previousStatus.phase !== status.phase || previousStatus.error !== status.error) {
      this.options.onTransition?.(service, previousStatus.phase, { ...status });
    }
  }
}
