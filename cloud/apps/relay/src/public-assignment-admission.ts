type AssignmentAdmissionLease = { release(): void }
type CancelWait = () => void
// Anonymous until its caller authenticates; only then does it carry a host.
type ReservedPermit = AssignmentAdmissionLease & { bind(relayHostId: string): void }
type ReservedWaiter = {
  resolve: (permit: ReservedPermit | null) => void
  cancelWait: CancelWait
}
export type ReservedAdmission<T> =
  | { status: 'granted'; lease: AssignmentAdmissionLease; credential: T }
  | { status: 'rejected' }
  | { status: 'unauthenticated' }
// Per-call sink: acquire() keeps returning null so callers stay unchanged, and the
// reason rides out of band to whoever made this particular request.
type RejectionSink = (reason: AssignmentAdmissionRejection) => void
type PendingAssignment = {
  relayHostId: string
  resolve: (lease: AssignmentAdmissionLease | null) => void
  cancelWait: CancelWait
  notifyRejected?: RejectionSink
}

// Every rejection here becomes an identical 503, so without the reason a busy
// director and a self-throttling host are indistinguishable in production.
export type AssignmentAdmissionRejection =
  | 'host-in-flight'
  | 'host-rate-limited'
  | 'queue-full'
  | 'wait-timeout'
  | 'superseded'
  | 'reserved-unavailable'

const MAX_TRACKED_HOSTS = 4_096

type LeaseKind = 'placement' | 'drain-return'

export class RelayPublicAssignmentAdmission {
  private active = 0
  private activeReserved = 0
  private activeDrainReturn = 0
  private readonly activeDrainReturnHosts = new Set<string>()
  private readonly queuedDrainReturnHosts = new Set<string>()
  private readonly lastDrainReturnAttemptByHost = new Map<string, number>()
  private readonly pendingDrainReturns: PendingAssignment[] = []
  private readonly activeAssignmentHosts = new Set<string>()
  private readonly activeReservedHosts = new Set<string>()
  private readonly queuedAssignmentHosts = new Set<string>()
  private readonly lastAttemptByHost = new Map<string, number>()
  private readonly lastReservedAttemptByHost = new Map<string, number>()
  private readonly pendingAssignments: PendingAssignment[] = []
  private pendingReserved: ReservedWaiter | undefined
  private readonly placementReleaseWaiters = new Map<string, () => void>()

  constructor(
    private readonly options: {
      maxConcurrent: number
      maxQueued?: number
      waitMs?: number
      maxReservedConcurrent?: number
      reservedWaitMs?: number
      // Drain returns borrow placement permits: their re-placement is placement
      // work, serialized on the same store mutex, so it fits the pool budget the
      // placement lane already has. Placement and reserved waiters go first.
      maxDrainReturnConcurrent?: number
      maxDrainReturnQueued?: number
      drainReturnWaitMs?: number
      drainReturnMinIntervalMs?: number
      minIntervalMs: number
      now?: () => number
      schedule?: (callback: () => void, delayMs: number) => CancelWait
      onRejected?: (reason: AssignmentAdmissionRejection) => void
    }
  ) {}

  get queuedDrainReturns(): number {
    return this.pendingDrainReturns.length
  }

  // Rejections here are the drain lane's, so they skip the placement onRejected hook.
  async acquireDrainReturn(
    relayHostId: string,
    notifyRejected: RejectionSink
  ): Promise<AssignmentAdmissionLease | null> {
    const now = (this.options.now ?? Date.now)()
    if (
      this.activeDrainReturnHosts.has(relayHostId) ||
      this.queuedDrainReturnHosts.has(relayHostId)
    ) {
      notifyRejected('host-in-flight')
      return null
    }
    const lastAttempt = this.lastDrainReturnAttemptByHost.get(relayHostId)
    if (
      lastAttempt !== undefined &&
      now - lastAttempt < (this.options.drainReturnMinIntervalMs ?? 0)
    ) {
      notifyRejected('host-rate-limited')
      return null
    }
    if (this.pendingDrainReturns.length === 0 && this.canGrantDrainReturn()) {
      this.recordAttempt(this.lastDrainReturnAttemptByHost, relayHostId, now)
      return this.createLease(relayHostId, 'drain-return')
    }
    if (this.pendingDrainReturns.length >= (this.options.maxDrainReturnQueued ?? 0)) {
      notifyRejected('queue-full')
      return null
    }
    return await new Promise((resolve) => {
      const schedule = this.options.schedule ?? defaultSchedule
      let cancelWait: CancelWait = () => undefined
      const pending: PendingAssignment = {
        relayHostId,
        resolve,
        cancelWait: () => cancelWait(),
        notifyRejected
      }
      this.pendingDrainReturns.push(pending)
      this.queuedDrainReturnHosts.add(relayHostId)
      cancelWait = schedule(() => {
        const index = this.pendingDrainReturns.indexOf(pending)
        if (index === -1) return
        this.pendingDrainReturns.splice(index, 1)
        this.queuedDrainReturnHosts.delete(relayHostId)
        notifyRejected('wait-timeout')
        resolve(null)
      }, this.options.drainReturnWaitMs ?? 1_000)
    })
  }

  async acquire(
    relayHostId: string,
    notifyRejected?: RejectionSink
  ): Promise<AssignmentAdmissionLease | null> {
    const now = (this.options.now ?? Date.now)()
    const lastAttempt = this.lastAttemptByHost.get(relayHostId)
    if (
      this.activeAssignmentHosts.has(relayHostId) ||
      this.activeReservedHosts.has(relayHostId) ||
      this.queuedAssignmentHosts.has(relayHostId)
    ) {
      return this.reject('host-in-flight', notifyRejected)
    }
    if (lastAttempt !== undefined && now - lastAttempt < this.options.minIntervalMs) {
      return this.reject('host-rate-limited', notifyRejected)
    }
    if (
      this.active < this.options.maxConcurrent &&
      this.pendingReserved === undefined &&
      this.pendingAssignments.length === 0
    ) {
      this.recordAttempt(this.lastAttemptByHost, relayHostId, now)
      return this.createLease(relayHostId, 'placement')
    }
    if (this.pendingAssignments.length >= (this.options.maxQueued ?? 0)) {
      return this.reject('queue-full', notifyRejected)
    }

    return await new Promise((resolve) => {
      const schedule = this.options.schedule ?? defaultSchedule
      let cancelWait: CancelWait = () => undefined
      const pending: PendingAssignment = {
        relayHostId,
        resolve,
        cancelWait: () => cancelWait(),
        notifyRejected
      }
      this.pendingAssignments.push(pending)
      this.queuedAssignmentHosts.add(relayHostId)
      cancelWait = schedule(() => {
        const index = this.pendingAssignments.indexOf(pending)
        if (index === -1) return
        this.pendingAssignments.splice(index, 1)
        this.queuedAssignmentHosts.delete(relayHostId)
        resolve(this.reject('wait-timeout', notifyRejected))
        this.grantPendingDrainReturns()
      }, this.options.waitMs ?? 1_000)
    })
  }

  // The credential check runs under an anonymous permit: its lookup stays inside the
  // director's database budget, yet a caller that fails it never cancels the host's
  // queued placement, starts its retry clock, or marks it in flight.
  async acquireReserved<T>(
    relayHostId: string,
    authenticate: () => Promise<T | null>,
    notifyRejected?: RejectionSink
  ): Promise<ReservedAdmission<T>> {
    const maxReservedConcurrent = this.options.maxReservedConcurrent ?? 0
    const lastAttempt = this.lastReservedAttemptByHost.get(relayHostId)
    if (maxReservedConcurrent === 0 || this.activeReserved >= maxReservedConcurrent) {
      return this.rejectReserved('reserved-unavailable', notifyRejected)
    }
    if (this.activeReservedHosts.has(relayHostId)) {
      return this.rejectReserved('host-in-flight', notifyRejected)
    }
    if (this.pendingReserved !== undefined) {
      return this.rejectReserved('reserved-unavailable', notifyRejected)
    }
    if (lastAttempt !== undefined && this.now() - lastAttempt < this.options.minIntervalMs) {
      return this.rejectReserved('host-rate-limited', notifyRejected)
    }
    const permit = await this.acquireReservedPermit(notifyRejected)
    if (!permit) return { status: 'rejected' }
    let credential: T | null
    try {
      credential = await authenticate()
    } catch (error) {
      permit.release()
      throw error
    }
    if (credential === null) {
      permit.release()
      return { status: 'unauthenticated' }
    }
    const lease = await this.bindReserved(relayHostId, permit, notifyRejected)
    return lease ? { status: 'granted', lease, credential } : { status: 'rejected' }
  }

  private async acquireReservedPermit(
    notifyRejected?: RejectionSink
  ): Promise<ReservedPermit | null> {
    if (this.active < this.options.maxConcurrent) return this.createReservedPermit()
    return await new Promise((resolve) => {
      const schedule = this.options.schedule ?? defaultSchedule
      let cancelWait: CancelWait = () => undefined
      const waiter: ReservedWaiter = { resolve, cancelWait: () => cancelWait() }
      this.pendingReserved = waiter
      cancelWait = schedule(() => {
        if (this.pendingReserved !== waiter) return
        this.pendingReserved = undefined
        resolve(this.reject('wait-timeout', notifyRejected))
        this.grantPendingAssignments()
        this.grantPendingDrainReturns()
      }, this.options.reservedWaitMs ?? 1_000)
    })
  }

  private async bindReserved(
    relayHostId: string,
    permit: ReservedPermit,
    notifyRejected?: RejectionSink
  ): Promise<AssignmentAdmissionLease | null> {
    // Rechecked: another authenticated caller for this host may have bound meanwhile.
    if (this.activeReservedHosts.has(relayHostId)) {
      permit.release()
      return this.reject('host-in-flight', notifyRejected)
    }
    const now = this.now()
    const lastAttempt = this.lastReservedAttemptByHost.get(relayHostId)
    if (lastAttempt !== undefined && now - lastAttempt < this.options.minIntervalMs) {
      permit.release()
      return this.reject('host-rate-limited', notifyRejected)
    }
    this.recordAttempt(this.lastReservedAttemptByHost, relayHostId, now)
    permit.bind(relayHostId)
    this.cancelQueuedAssignment(relayHostId)
    // Same-host placement and recovery stay serialized; holding the permit keeps recovery's priority.
    if (
      this.activeAssignmentHosts.has(relayHostId) &&
      !(await this.awaitPlacementRelease(relayHostId))
    ) {
      permit.release()
      return this.reject('wait-timeout', notifyRejected)
    }
    return permit
  }

  private async awaitPlacementRelease(relayHostId: string): Promise<boolean> {
    return await new Promise((resolve) => {
      const schedule = this.options.schedule ?? defaultSchedule
      const cancelWait = schedule(() => {
        this.placementReleaseWaiters.delete(relayHostId)
        resolve(false)
      }, this.options.reservedWaitMs ?? 1_000)
      this.placementReleaseWaiters.set(relayHostId, () => {
        this.placementReleaseWaiters.delete(relayHostId)
        cancelWait()
        resolve(true)
      })
    })
  }

  private createReservedPermit(): ReservedPermit {
    this.active++
    this.activeReserved++
    let boundHost: string | undefined
    let released = false
    return {
      bind: (relayHostId) => {
        boundHost = relayHostId
        this.activeReservedHosts.add(relayHostId)
      },
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.activeReserved = Math.max(0, this.activeReserved - 1)
        if (boundHost !== undefined) this.activeReservedHosts.delete(boundHost)
        this.grantPendingReserved()
        this.grantPendingAssignments()
        this.grantPendingDrainReturns()
      }
    }
  }

  private rejectReserved(
    reason: AssignmentAdmissionRejection,
    notifyRejected?: RejectionSink
  ): ReservedAdmission<never> {
    this.reject(reason, notifyRejected)
    return { status: 'rejected' }
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }

  private createLease(relayHostId: string, kind: LeaseKind): AssignmentAdmissionLease {
    this.active++
    if (kind === 'drain-return') {
      this.activeDrainReturn++
      this.activeDrainReturnHosts.add(relayHostId)
    } else {
      this.activeAssignmentHosts.add(relayHostId)
    }
    let released = false
    return {
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        if (kind === 'drain-return') {
          this.activeDrainReturn = Math.max(0, this.activeDrainReturn - 1)
          this.activeDrainReturnHosts.delete(relayHostId)
        } else {
          this.activeAssignmentHosts.delete(relayHostId)
          this.placementReleaseWaiters.get(relayHostId)?.()
        }
        this.grantPendingReserved()
        this.grantPendingAssignments()
        this.grantPendingDrainReturns()
      }
    }
  }

  private canGrantDrainReturn(): boolean {
    return (
      this.activeDrainReturn < (this.options.maxDrainReturnConcurrent ?? 0) &&
      this.active < this.options.maxConcurrent &&
      this.pendingReserved === undefined &&
      this.pendingAssignments.length === 0
    )
  }

  private grantPendingDrainReturns(): void {
    while (this.pendingDrainReturns.length > 0 && this.canGrantDrainReturn()) {
      const pending = this.pendingDrainReturns.shift()!
      this.queuedDrainReturnHosts.delete(pending.relayHostId)
      pending.cancelWait()
      this.recordAttempt(
        this.lastDrainReturnAttemptByHost,
        pending.relayHostId,
        (this.options.now ?? Date.now)()
      )
      pending.resolve(this.createLease(pending.relayHostId, 'drain-return'))
    }
  }

  private grantPendingReserved(): void {
    const pending = this.pendingReserved
    if (!pending || this.active >= this.options.maxConcurrent) return
    this.pendingReserved = undefined
    pending.cancelWait()
    pending.resolve(this.createReservedPermit())
  }

  private grantPendingAssignments(): void {
    while (
      this.pendingReserved === undefined &&
      this.active < this.options.maxConcurrent &&
      this.pendingAssignments.length > 0
    ) {
      const pending = this.pendingAssignments.shift()!
      this.queuedAssignmentHosts.delete(pending.relayHostId)
      pending.cancelWait()
      this.recordAttempt(
        this.lastAttemptByHost,
        pending.relayHostId,
        (this.options.now ?? Date.now)()
      )
      pending.resolve(this.createLease(pending.relayHostId, 'placement'))
    }
  }

  private cancelQueuedAssignment(relayHostId: string): void {
    const index = this.pendingAssignments.findIndex(
      (pending) => pending.relayHostId === relayHostId
    )
    if (index === -1) return
    const [pending] = this.pendingAssignments.splice(index, 1)
    this.queuedAssignmentHosts.delete(relayHostId)
    pending?.cancelWait()
    // The sink rides on the pending record: this rejects a different caller's request.
    pending?.resolve(this.reject('superseded', pending.notifyRejected))
  }

  private reject(reason: AssignmentAdmissionRejection, notifyRejected?: RejectionSink): null {
    this.options.onRejected?.(reason)
    notifyRejected?.(reason)
    return null
  }

  private recordAttempt(attempts: Map<string, number>, relayHostId: string, now: number): void {
    attempts.delete(relayHostId)
    attempts.set(relayHostId, now)
    if (attempts.size > MAX_TRACKED_HOSTS) {
      attempts.delete(attempts.keys().next().value!)
    }
  }
}

function defaultSchedule(callback: () => void, delayMs: number): CancelWait {
  const timer = setTimeout(callback, delayMs)
  return () => clearTimeout(timer)
}
