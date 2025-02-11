import { CommitID, StreamID } from '@ceramicnetwork/streamid'
import {
  AnchorService,
  AnchorStatus,
  CommitType,
  Context,
  CreateOpts,
  DiagnosticsLogger,
  InternalOpts,
  LoadOpts,
  PinningOpts,
  PublishOpts,
  StreamState,
  StreamUtils,
  SyncOptions,
  UnreachableCaseError,
  UpdateOpts,
} from '@ceramicnetwork/common'
import { PinStore } from '../store/pin-store.js'
import { ExecutionQueue } from './execution-queue.js'
import { RunningState } from './running-state.js'
import { StateManager } from './state-manager.js'
import type { Dispatcher } from '../dispatcher.js'
import type { ConflictResolution } from '../conflict-resolution.js'
import type { HandlersMap } from '../handlers-map.js'
import { Observable } from 'rxjs'
import { StateCache } from './state-cache.js'
import { SnapshotState } from './snapshot-state.js'
import { Utils } from '../utils.js'
import { LocalIndexApi } from '../indexing/local-index-api.js'
import { IKVStore } from '../store/ikv-store.js'
import { AnchorRequestStore } from '../store/anchor-request-store.js'
import { ServiceMetrics as Metrics } from '@ceramicnetwork/observability'

const CACHE_EVICTED_MEMORY = 'cache_eviction_memory'
const CACHE_HIT_MEMORY = 'cache_hit_memory'
const CACHE_HIT_LOCAL = 'cache_hit_local'
const CACHE_HIT_REMOTE = 'cache_hit_remote'
const STREAM_SYNC = 'stream_sync'

export type RepositoryDependencies = {
  dispatcher: Dispatcher
  pinStore: PinStore
  keyValueStore: IKVStore
  anchorRequestStore: AnchorRequestStore
  context: Context
  handlers: HandlersMap
  anchorService: AnchorService
  conflictResolution: ConflictResolution
  indexing: LocalIndexApi
}

const DEFAULT_LOAD_OPTS = { sync: SyncOptions.PREFER_CACHE, syncTimeoutSeconds: 3 }

enum OperationType {
  CREATE,
  UPDATE,
  LOAD,
}
/**
 * Indicate if the stream should be indexed.
 */
function shouldIndex(state$: RunningState, index: LocalIndexApi): boolean {
  const model = state$.state?.metadata?.model
  if (!model) return false
  return index.shouldIndexStream(model)
}

export class Repository {
  /**
   * Serialize loading operations per streamId.
   */
  readonly loadingQ: ExecutionQueue

  /**
   * Serialize operations on state per streamId.
   */
  readonly executionQ: ExecutionQueue

  /**
   * In-memory cache of the currently running streams.
   */
  readonly inmemory: StateCache<RunningState>

  /**
   * Various dependencies.
   */
  #deps: RepositoryDependencies

  /**
   * Instance of StateManager for performing operations on stream state.
   */
  stateManager: StateManager

  /**
   * @param cacheLimit - Maximum number of streams to store in memory cache.
   * @param logger - Where we put diagnostics messages.
   * @param concurrencyLimit - Maximum number of concurrently running tasks on the streams.
   */
  constructor(
    cacheLimit: number,
    concurrencyLimit: number,
    private readonly logger: DiagnosticsLogger
  ) {
    this.loadingQ = new ExecutionQueue('loading', concurrencyLimit, logger)
    this.executionQ = new ExecutionQueue('execution', concurrencyLimit, logger)
    this.inmemory = new StateCache(cacheLimit, (state$) => {
      if (state$.subscriptionSet.size > 0) {
        logger.debug(`Stream ${state$.id} evicted from cache while having subscriptions`)
      }
      Metrics.count(CACHE_EVICTED_MEMORY, 1)
      state$.complete()
    })
    this.updates$ = this.updates$.bind(this)
  }

  async injectKeyValueStore(stateStore: IKVStore): Promise<void> {
    this.setDeps({
      ...this.#deps,
      keyValueStore: stateStore,
    })
    await this.init()
  }

  async init(): Promise<void> {
    await this.pinStore.open(this.#deps.keyValueStore)
    await this.anchorRequestStore.open(this.#deps.keyValueStore)
    await this.index.init()
  }

  get pinStore(): PinStore {
    return this.#deps.pinStore
  }

  get anchorRequestStore(): AnchorRequestStore {
    return this.#deps.anchorRequestStore
  }

  get index(): LocalIndexApi {
    return this.#deps.indexing
  }

  // Ideally this would be provided in the constructor, but circular dependencies in our initialization process make this necessary for now
  setDeps(deps: RepositoryDependencies): void {
    this.#deps = deps
    this.stateManager = new StateManager(
      deps.dispatcher,
      deps.pinStore,
      deps.anchorRequestStore,
      this.executionQ,
      deps.anchorService,
      deps.conflictResolution,
      this.logger,
      (streamId) => this.fromMemoryOrStore(streamId),
      (streamId, opts) => this.load(streamId, opts),
      // TODO (NET-1687): remove as part of refactor to push indexing into state-manager.ts
      this.indexStreamIfNeeded.bind(this),
      deps.indexing
    )
  }

  private fromMemory(streamId: StreamID): RunningState | undefined {
    const state = this.inmemory.get(streamId.toString())
    if (state) {
      Metrics.count(CACHE_HIT_MEMORY, 1)
    }
    return state
  }

  private async fromStreamStateStore(streamId: StreamID): Promise<RunningState | undefined> {
    const streamState = await this.#deps.pinStore.stateStore.load(streamId)
    if (streamState) {
      Metrics.count(CACHE_HIT_LOCAL, 1)
      const runningState = new RunningState(streamState, true)
      this.add(runningState)
      const storedRequest = await this.anchorRequestStore.load(streamId)
      if (storedRequest !== null && this.stateManager.anchorService) {
        this.stateManager.confirmAnchorResponse(runningState, storedRequest.cid)
      }
      return runningState
    } else {
      return undefined
    }
  }

  private async fromNetwork(streamId: StreamID): Promise<RunningState> {
    const handler = this.#deps.handlers.get(streamId.typeName)
    const genesisCid = streamId.cid
    const commitData = await Utils.getCommitData(this.#deps.dispatcher, genesisCid, streamId)
    if (commitData == null) {
      throw new Error(`No genesis commit found with CID ${genesisCid.toString()}`)
    }
    Metrics.count(CACHE_HIT_REMOTE, 1)
    // Do not check for possible key revocation here, as we will do so later after loading the tip
    // (or learning that the genesis commit *is* the current tip), when we will have timestamp
    // information for when the genesis commit was anchored.
    commitData.disableTimecheck = true
    const state = await handler.applyCommit(commitData, this.#deps.context)
    const state$ = new RunningState(state, false)
    this.add(state$)
    this.logger.verbose(`Genesis commit for stream ${streamId.toString()} successfully loaded`)
    return state$
  }

  /**
   * Helper function for loading at least the genesis commit state for a stream.
   * WARNING: This should only be called from within a thread in the loadingQ!!!
   *
   * @param streamId
   * @returns a tuple whose first element is the state that was loaded, and whose second element
   *   is a boolean representing whether we believe that state should be the most update-to-date
   *   state for that stream, or whether it could be behind the current tip and needs to be synced.
   */
  async _loadGenesis(streamId: StreamID): Promise<[RunningState, boolean]> {
    let stream = this.fromMemory(streamId)
    if (stream) {
      return [stream, true]
    }

    stream = await this.fromStreamStateStore(streamId)
    if (stream) {
      return [stream, this.stateManager.wasPinnedStreamSynced(streamId)]
    }

    stream = await this.fromNetwork(streamId)
    return [stream, false]
  }
  /**
   * Returns a stream from wherever we can get information about it.
   * Starts by checking if the stream state is present in the in-memory cache, if not then
   * checks the state store, and finally loads the stream from pubsub.
   */
  async load(streamId: StreamID, opts: LoadOpts & InternalOpts): Promise<RunningState> {
    opts = { ...DEFAULT_LOAD_OPTS, ...opts }

    const [state$, synced] = await this.loadingQ.forStream(streamId).run(async () => {
      switch (opts.sync) {
        case SyncOptions.PREFER_CACHE:
        case SyncOptions.SYNC_ON_ERROR: {
          const [streamState$, alreadySynced] = await this._loadGenesis(streamId)
          if (alreadySynced) {
            return [streamState$, alreadySynced]
          } else {
            await this.stateManager.sync(streamState$, opts.syncTimeoutSeconds * 1000)
            Metrics.count(STREAM_SYNC, 1)
            return [streamState$, true]
          }
        }
        case SyncOptions.NEVER_SYNC: {
          return this._loadGenesis(streamId)
        }
        case SyncOptions.SYNC_ALWAYS: {
          // When SYNC_ALWAYS is provided, we want to reapply and re-validate
          // the stream state.  We effectively throw out our locally stored state
          // as its possible that the commits that were used to construct that
          // state are no longer valid (for example if the CACAOs used to author them
          // have expired since they were first applied to the cached state object).
          // But if we were the only node on the network that knew about the most
          // recent tip, we don't want to totally forget about that, so we pass the tip in
          // to `sync` so that it gets considered alongside whatever tip we learn
          // about from the network.
          const [fromNetwork$, fromMemoryOrStore] = await Promise.all([
            this.fromNetwork(streamId),
            this.fromMemoryOrStore(streamId),
          ])
          await this.stateManager.sync(
            fromNetwork$,
            opts.syncTimeoutSeconds * 1000,
            fromMemoryOrStore?.tip
          )
          Metrics.count(STREAM_SYNC, 1)
          return [fromNetwork$, true]
        }
        default:
          throw new UnreachableCaseError(opts.sync, 'Invalid sync option')
      }
    })

    if (!opts.skipCacaoExpirationChecks) {
      StreamUtils.checkForCacaoExpiration(state$.state)
    }

    if (synced && state$.isPinned) {
      this.stateManager.markPinnedAndSynced(state$.id)
    }

    return state$
  }

  /**
   * Load the state for a stream at a specific CommitID.
   * @param commitId
   * @param opts
   */
  async loadAtCommit(commitId: CommitID, opts: LoadOpts): Promise<SnapshotState> {
    // Start by loading the current state of the stream. This might cause us to load more commits
    // for the stream than is ultimately necessary, but doing so increases the chances that we
    // detect that the CommitID specified is rejected by the conflict resolution rules due to
    // conflict with the stream's canonical branch of history.
    // We also skip CACAO expiration checking during this initial load as its possible
    // that the CommitID we are being asked to load may in fact be an anchor commit with
    // the timestamp information that will reveal to us that the CACAO didn't actually expire.
    const optsSkippingCACAOChecks = { ...opts, skipCacaoExpirationChecks: true }
    const base$ = await this.load(commitId.baseID, optsSkippingCACAOChecks)
    const stateAtCommit = await this.stateManager.atCommit(base$, commitId)

    // Since we skipped CACAO expiration checking earlier we need to make sure to do it here.
    StreamUtils.checkForCacaoExpiration(stateAtCommit.state)

    return stateAtCommit
  }

  /**
   * Load the state for a stream as it was at a specified wall clock time, based on the anchor
   * timestamps of AnchorCommits in the log.
   * @param streamId
   * @param opts - must contain an 'atTime' parameter
   */
  async loadAtTime(streamId: StreamID, opts: LoadOpts): Promise<SnapshotState> {
    const base$ = await this.load(streamId.baseID, opts)
    return this.stateManager.atTime(base$, opts.atTime)
  }

  /**
   * Applies commit to the existing state
   *
   * @param streamId - Stream ID to update
   * @param commit - Commit data
   * @param opts - Stream initialization options (request anchor, wait, etc.)
   */
  async applyCommit(
    streamId: StreamID,
    commit: any,
    opts: CreateOpts | UpdateOpts
  ): Promise<RunningState> {
    this.logger.verbose(`Repository apply commit to stream ${streamId.toString()}`)
    const state$ = await this.stateManager.applyCommit(streamId, commit, opts)
    await this.applyWriteOpts(state$, opts, OperationType.UPDATE)
    this.logger.verbose(`Repository applied write options to stream ${streamId.toString()}`)
    return state$
  }

  /**
   * Apply options relating to authoring a new commit
   *
   * @param state$ - Running State
   * @param opts - Initialization options (request anchor, publish to pubsub, etc.)
   * @private
   */
  async applyWriteOpts(state$: RunningState, opts: CreateOpts | UpdateOpts, opType: OperationType) {
    await this.stateManager.applyWriteOpts(state$, opts)

    await this.handlePinOpts(state$, opts as PinningOpts, opType)
  }

  /**
   * Applies the given PinningOpts that the user provided to pin or unpin the stream.
   * Unpinning streams isn't allowed through the CRUD API, so if unpin is false this will
   * generally throw an Error.  The one exception is for creates.  When creating a brand
   * new stream it is okay to set that stream to not be pinned. To unpin an existing stream
   * one must use the AdminAPI.
   * @param state$
   * @param opts
   * @param opType - what type of operation is being performed
   */
  async handlePinOpts(
    state$: RunningState,
    opts: PinningOpts,
    opType: OperationType
  ): Promise<void> {
    if (opts.pin !== undefined && opType !== OperationType.CREATE) {
      const pinStr = opts.pin ? 'pin' : 'unpin'
      const opStr = opType == OperationType.UPDATE ? 'update' : 'load'
      //TODO(CDB-2314): An error should be thrown once fully deprecated
      console.warn(
        `Cannot pin or unpin streams through the CRUD APIs. To change stream pin state use the admin.pin API with an authenticated admin DID. Attempting to ${pinStr} stream ${StreamUtils.streamIdFromState(
          state$.state
        ).toString()} as part of a ${opStr} operation`
      )
      return
    }

    if (
      opts.pin ||
      (opts.pin === undefined && shouldIndex(state$, this.index)) ||
      (opts.pin === undefined && opType == OperationType.CREATE)
    ) {
      await this.pin(state$)
    } else if (opts.pin === false) {
      await this.unpin(state$)
    }
  }

  /**
   * Handles new stream creation by loading genesis commit into memory and then handling the given
   * CreateOpts for the genesis commit.
   * @param streamId
   * @param opts
   */
  async applyCreateOpts(streamId: StreamID, opts: CreateOpts): Promise<RunningState> {
    const state = await this.load(streamId, opts)
    // Create operations can actually be load operations when using deterministic streams, so we
    // ensure that the stream only has a single commit in its log to properly consider it a create.
    const opType = state.state.log.length == 1 ? OperationType.CREATE : OperationType.LOAD
    await this.applyWriteOpts(state, opts, opType)
    return state
  }

  /**
   * Return a stream, either from cache or re-constructed from state store, but will not load from the network.
   * Adds the stream to cache.
   */
  async fromMemoryOrStore(streamId: StreamID): Promise<RunningState | undefined> {
    const fromMemory = this.fromMemory(streamId)
    if (fromMemory) return fromMemory
    return this.fromStreamStateStore(streamId)
  }

  /**
   * Return a stream state, either from cache or from state store.
   */
  async streamState(streamId: StreamID): Promise<StreamState | undefined> {
    const fromMemory = this.inmemory.get(streamId.toString())
    if (fromMemory) {
      return fromMemory.state
    } else {
      return this.#deps.pinStore.stateStore.load(streamId)
    }
  }

  /**
   * Adds the stream's RunningState to the in-memory cache and subscribes the Repository's global feed$ to receive changes emitted by that RunningState
   */
  add(state$: RunningState): void {
    this.inmemory.set(state$.id.toString(), state$)
  }

  pin(state$: RunningState, force?: boolean): Promise<void> {
    return this.#deps.pinStore.add(state$, force)
  }

  async unpin(state$: RunningState, opts?: PublishOpts): Promise<void> {
    if (shouldIndex(state$, this.index)) {
      throw new Error(
        `Cannot unpin actively indexed stream (${state$.id.toString()}) with model: ${
          state$.state.metadata.model
        }`
      )
    }

    if (opts?.publish) {
      this.stateManager.publishTip(state$)
    }

    this.stateManager.markUnpinned(state$.id)
    return this.#deps.pinStore.rm(state$)
  }

  /**
   * List pinned streams as array of StreamID strings.
   * If `streamId` is passed, indicate if it is pinned.
   */
  async listPinned(streamId?: StreamID): Promise<string[]> {
    return this.#deps.pinStore.ls(streamId)
  }

  /**
   * Returns the StreamState of a random pinned stream from the state store
   */
  async randomPinnedStreamState(): Promise<StreamState | null> {
    // First get a random streamID from the state store.
    const res = await this.#deps.pinStore.stateStore.listStoredStreamIDs(null, 1)
    if (res.length == 0) {
      return null
    }
    if (res.length > 1) {
      // This should be impossible and indicates a programming error with how the state store
      // listStoredStreamIDs() call is enforcing the limit argument.
      throw new Error(
        `Expected a single streamID from the state store, but got ${res.length} streamIDs instead`
      )
    }

    const [streamID] = res
    return this.#deps.pinStore.stateStore.load(StreamID.fromString(streamID))
  }

  /**
   * Helper function to add stream to db index if it has a 'model' in its metadata.
   * @public
   */
  public async indexStreamIfNeeded(state$: RunningState): Promise<void> {
    if (!state$.value.metadata.model) {
      return
    }

    const asDate = (unixTimestamp: number | null | undefined) => {
      return unixTimestamp ? new Date(unixTimestamp * 1000) : null
    }

    // TODO(NET-1614) Test that the timestamps are correctly passed to the Index API.
    const lastAnchor = asDate(StreamUtils.anchorTimestampFromState(state$.value))
    const firstAnchor = asDate(
      state$.value.log.find((log) => log.type == CommitType.ANCHOR)?.timestamp
    )
    const streamContent = {
      model: state$.value.metadata.model,
      streamID: state$.id,
      controller: state$.value.metadata.controllers[0],
      streamContent: state$.value.content,
      tip: state$.tip,
      lastAnchor: lastAnchor,
      firstAnchor: firstAnchor,
    }

    await this.index.indexStream(streamContent)
  }

  /**
   * Updates for the StreamState, even if a (pinned or not pinned) stream has already been evicted.
   * Marks the stream as durable, that is not subject to cache eviction.
   *
   * First, we try to get the running state from memory or state store. If found, it is used as a source
   * of updates. If not found, we use StreamState passed as `init` param as a future source of updates.
   * Anyway, we mark it as unevictable.
   *
   * When a subscription to the observable stops, we check if there are other subscriptions to the same
   * RunningState. We only consider the RunningState free, if there are no more subscriptions.
   * This RunningState is subject to future cache eviction.
   *
   * @param init
   */
  updates$(init: StreamState): Observable<StreamState> {
    return new Observable<StreamState>((subscriber) => {
      const id = new StreamID(init.type, init.log[0].cid)
      this.fromMemoryOrStore(id).then((found) => {
        const state$ = found || new RunningState(init, false)
        this.inmemory.endure(id.toString(), state$)
        state$.subscribe(subscriber).add(() => {
          if (state$.observers.length === 0) {
            this.inmemory.free(id.toString())
          }
        })
      })
    })
  }

  async close(): Promise<void> {
    await this.loadingQ.close()
    await this.executionQ.close()
    Array.from(this.inmemory).forEach(([id, stream]) => {
      this.inmemory.delete(id)
      stream.complete()
    })
    await this.#deps.pinStore.close()
    await this.index.close()
  }
}
