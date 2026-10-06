import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION
} from '../../shared/protocol-version'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import {
  isOrchestrationMutation,
  orchestrationMigrationData
} from '../../shared/orchestration-rpc-contract'
import type { RuntimeStatus } from '../../shared/runtime-types'
import type {
  OrchestrationEnvironmentCallOptions,
  OrchestrationEnvironmentTransport,
  OrchestrationWorkerServer
} from './orchestration/environment-transport'
import { OrchestrationError } from './orchestration/orchestration-error'
import {
  clearFederationAckCheckpoints,
  releaseFederationAckCheckpoint
} from './orchestration/federation-ack-checkpoints'
import { syncFederatedDispatch } from './orchestration/federation-sync'
import type { OrchestrationDb } from './orchestration/db'
import type { OrcaRuntimeService } from './orca-runtime'

const FEDERATION_PULL_INTERVAL_MS = 1_000
const FEDERATION_PULL_MAX_BACKOFF_MS = 30_000

/** One poll loop per worker environment, covering every dispatch relayed through it. */
type EnvironmentRelay = {
  dispatchIds: Set<string>
  failedPulls: number
  timer: ReturnType<typeof setTimeout> | null
}

export class RuntimeOrchestrationFederation {
  private readonly relays = new Map<string, EnvironmentRelay>()
  private readonly syncs = new Map<string, { db: OrchestrationDb; promise: Promise<void> }>()
  private readonly warnings = new Set<string>()
  private terminalRecoveryTimer: ReturnType<typeof setTimeout> | null = null
  private terminalRecoveryInFlight: Promise<void> | null = null
  private terminalRecoveryRowId = 0
  private relayGeneration = 0

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly transport: OrchestrationEnvironmentTransport | null
  ) {}

  resetForDatabaseChange(): void {
    this.relayGeneration += 1
    this.clearRelays()
    if (this.terminalRecoveryTimer) {
      clearTimeout(this.terminalRecoveryTimer)
    }
    this.terminalRecoveryTimer = null
    this.terminalRecoveryInFlight = null
    this.terminalRecoveryRowId = 0
    clearFederationAckCheckpoints(this.runtime)
    this.syncs.clear()
    this.warnings.clear()
  }

  resolveWorkerServer(selector: string): OrchestrationWorkerServer {
    if (!this.transport) {
      throw new OrchestrationError(
        'server_required',
        'Connected-server orchestration is unavailable in this runtime.'
      )
    }
    return this.transport.resolve(selector)
  }

  async callWorkerServer(
    selector: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
    envelope?: RuntimeOrchestrationEnvelope,
    internal?: OrchestrationEnvironmentCallOptions
  ): Promise<unknown> {
    if (!this.transport) {
      throw new OrchestrationError(
        'server_required',
        'Connected-server orchestration is unavailable in this runtime.'
      )
    }
    if (isOrchestrationMutation(method, params) && !internal?.contractVerified) {
      const statusResponse = await this.transport.call(
        selector,
        'status.get',
        undefined,
        timeoutMs,
        undefined,
        internal?.expectedEnvironmentPairingRevision
      )
      if (statusResponse.ok === false) {
        throw new OrchestrationError(
          statusResponse.error.code,
          statusResponse.error.message,
          statusResponse.error.data
        )
      }
      const status = statusResponse.result as RuntimeStatus
      if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
        throw new OrchestrationError(
          'orchestration_migration_required',
          'The connected worker server does not support the current orchestration contract. No effects were applied.',
          orchestrationMigrationData('runtime_capability_missing')
        )
      }
    }
    const response = await this.transport.call(
      selector,
      method,
      params,
      timeoutMs,
      method.startsWith('orchestration.')
        ? { ...envelope, orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION }
        : envelope,
      internal?.expectedEnvironmentPairingRevision
    )
    if (response.ok === false) {
      throw new OrchestrationError(response.error.code, response.error.message, response.error.data)
    }
    return response.result
  }

  async sync(runId?: string): Promise<void> {
    if (!this.transport) {
      return
    }
    const dispatches = this.runtime.getOrchestrationDb().listActiveFederatedDispatches(runId)
    await Promise.allSettled(dispatches.map((dispatch) => this.syncDispatch(dispatch.dispatch_id)))
  }

  syncDispatch(dispatchId: string): Promise<void> {
    const db = this.runtime.getOrchestrationDb()
    const current = this.syncs.get(dispatchId)
    if (current?.db === db) {
      return current.promise
    }
    const sync = syncFederatedDispatch(this.runtime, dispatchId)
      .then(() => {
        if (this.syncs.get(dispatchId)?.promise === sync) {
          this.warnings.delete(dispatchId)
        }
      })
      .catch((error: unknown) => {
        if (this.syncs.get(dispatchId)?.promise === sync && !this.warnings.has(dispatchId)) {
          console.warn(`[orchestration] Federation sync failed for ${dispatchId}:`, error)
          this.warnings.add(dispatchId)
        }
        throw error
      })
      .finally(() => {
        if (this.syncs.get(dispatchId)?.promise !== sync) {
          return
        }
        this.syncs.delete(dispatchId)
        if (!db.isFederatedDispatchRelayEligible(dispatchId)) {
          releaseFederationAckCheckpoint(this.runtime, dispatchId)
        }
      })
    this.syncs.set(dispatchId, { db, promise: sync })
    return sync
  }

  async syncDispatchAfterCurrent(dispatchId: string): Promise<void> {
    const db = this.runtime.getOrchestrationDb()
    const current = this.syncs.get(dispatchId)
    if (current?.db === db) {
      await current.promise.catch(() => undefined)
    }
    await this.syncDispatch(dispatchId)
  }

  ensureRelay(runId?: string): void {
    if (!this.transport) {
      return
    }
    for (const dispatch of this.runtime.getOrchestrationDb().listActiveFederatedDispatches(runId)) {
      let relay = this.relays.get(dispatch.environment_id)
      if (relay?.dispatchIds.has(dispatch.dispatch_id)) {
        continue
      }
      if (!relay) {
        relay = { dispatchIds: new Set(), failedPulls: 0, timer: null }
        this.relays.set(dispatch.environment_id, relay)
        this.scheduleEnvironmentPull(dispatch.environment_id, relay, FEDERATION_PULL_INTERVAL_MS)
      }
      relay.dispatchIds.add(dispatch.dispatch_id)
      // A newly relayed dispatch is pulled now, as before, not on the environment's next tick.
      void this.syncDispatch(dispatch.dispatch_id).catch(() => undefined)
    }
    this.ensureTerminalHistoryRecovery()
  }

  private scheduleEnvironmentPull(
    environmentId: string,
    relay: EnvironmentRelay,
    delayMs: number
  ): void {
    relay.timer = setTimeout(() => {
      relay.timer = null
      void this.pullEnvironment(environmentId, relay)
    }, delayMs)
    relay.timer.unref?.()
  }

  private async pullEnvironment(environmentId: string, relay: EnvironmentRelay): Promise<void> {
    const db = this.runtime.getOrchestrationDb()
    for (const dispatchId of relay.dispatchIds) {
      if (!db.isFederatedDispatchRelayEligible(dispatchId)) {
        relay.dispatchIds.delete(dispatchId)
        this.warnings.delete(dispatchId)
      }
    }
    if (relay.dispatchIds.size === 0) {
      this.relays.delete(environmentId)
      return
    }
    const results = await Promise.allSettled(
      [...relay.dispatchIds].map((dispatchId) => this.syncDispatch(dispatchId))
    )
    if (this.relays.get(environmentId) !== relay) {
      return
    }
    // Why: a pull that fails for every dispatch means the environment is unreachable;
    // retrying it every second only adds load, so back off until one pull succeeds.
    relay.failedPulls = results.some((result) => result.status === 'fulfilled')
      ? 0
      : relay.failedPulls + 1
    const delayMs =
      relay.failedPulls === 0
        ? FEDERATION_PULL_INTERVAL_MS
        : Math.min(
            FEDERATION_PULL_INTERVAL_MS * 2 ** (relay.failedPulls - 1),
            FEDERATION_PULL_MAX_BACKOFF_MS
          )
    this.scheduleEnvironmentPull(environmentId, relay, delayMs)
  }

  private clearRelays(): void {
    for (const relay of this.relays.values()) {
      if (relay.timer) {
        clearTimeout(relay.timer)
      }
    }
    this.relays.clear()
  }

  private ensureTerminalHistoryRecovery(): void {
    if (this.terminalRecoveryTimer || this.terminalRecoveryInFlight) {
      return
    }
    const generation = this.relayGeneration
    const recovery = this.recoverNextTerminalHistoryAcknowledgment(generation).catch((error) => {
      console.warn('[orchestration] terminal federation acknowledgment recovery failed', error)
    })
    this.terminalRecoveryInFlight = recovery
    void recovery.finally(() => {
      if (this.terminalRecoveryInFlight === recovery) {
        this.terminalRecoveryInFlight = null
      }
    })
  }

  private async recoverNextTerminalHistoryAcknowledgment(generation: number): Promise<void> {
    const db = this.runtime.getOrchestrationDb()
    let historical = db.findNextTerminalFederatedDispatchPendingAcknowledgment(
      this.terminalRecoveryRowId
    )
    if (!historical && this.terminalRecoveryRowId > 0) {
      this.terminalRecoveryRowId = 0
      historical = db.findNextTerminalFederatedDispatchPendingAcknowledgment(0)
    }
    if (!historical) {
      return
    }
    this.terminalRecoveryRowId = historical.rowId
    await this.runtime
      .syncOrchestrationFederatedDispatch(historical.dispatchId)
      .catch(() => undefined)
    if (generation !== this.relayGeneration) {
      return
    }
    this.terminalRecoveryTimer = setTimeout(() => {
      this.terminalRecoveryTimer = null
      this.ensureTerminalHistoryRecovery()
    }, 1_000)
    this.terminalRecoveryTimer.unref?.()
  }

  stopRelay(): void {
    this.relayGeneration += 1
    this.clearRelays()
    this.warnings.clear()
    this.syncs.clear()
    if (this.terminalRecoveryTimer) {
      clearTimeout(this.terminalRecoveryTimer)
    }
    this.terminalRecoveryTimer = null
    this.terminalRecoveryInFlight = null
    this.terminalRecoveryRowId = 0
    clearFederationAckCheckpoints(this.runtime)
  }
}
