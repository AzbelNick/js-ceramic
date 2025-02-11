import type { CID } from 'multiformats/cid'
import type { StreamID } from '@ceramicnetwork/streamid'
import type { SupportedNetwork } from '@ceramicnetwork/anchor-utils'

export type SyncConfig = {
  /**
   * Database connection string.
   */
  db: string
  chainId: SupportedNetwork
}

/**
 * Interface to determine if a sync has completed for a particular model
 */
export interface ISyncQueryApi {
  syncComplete(model: string): boolean
}

/**
 * Interface used with historical sync'ing to start model sync on one or more models, or to
 * shutdown the service providing the sync'ing
 */
export interface ISyncApi extends ISyncQueryApi {
  startModelSync(models: string | string[], startBlock?: number, endBlock?: number): Promise<void>
  stopModelSync(models: string | string[]): Promise<void>
  shutdown(): Promise<void>
}

// handles a commit found during a sync
// should be similar to: https://github.com/ceramicnetwork/js-ceramic/blob/6ae6e121b33132225f256762825e1439fd84f23a/packages/core/src/state-management/state-manager.ts#L210
export type HandleCommit = (streamId: StreamID, commit: CID, model?: StreamID) => Promise<void>

export interface IpfsService {
  retrieveFromIPFS(cid: CID | string, path?: string): Promise<any>
  retrieveCommit(cid: CID | string, streamId: StreamID): Promise<any>
  storeCommit(data: any, streamId?: StreamID): Promise<CID>
  storeRecord(record: Record<string, unknown>): Promise<CID>
}

export interface TreeMetadata {
  numEntries: number
  streamIds: string[]
}

export const REBUILD_ANCHOR_JOB = 'rebuildAnchorJob'
export interface RebuildAnchorJobData {
  models: string[]
  chainId: string
  txHash: string
  root: string
  txType?: string
}

export const HISTORY_SYNC_JOB = 'historySyncJob'
export const CONTINUOUS_SYNC_JOB = 'continuousSyncJob'

export type SyncJob = typeof HISTORY_SYNC_JOB | typeof CONTINUOUS_SYNC_JOB
export enum SyncJobType {
  Catchup,
  Reorg,
  Full,
  Continuous,
}
export interface SyncJobData {
  currentBlock?: number
  jobType: SyncJobType
  fromBlock: number
  toBlock: number
  models: string[]
}

export type JobData = RebuildAnchorJobData | SyncJobData
