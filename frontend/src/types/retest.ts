import type { Revisioned } from './persistence';

/**
 * 整箱复测批次（Box Retest Batch）
 * 在失配排查台对整个汇流箱发起：冻结每串基准 → 新读数归入批次 → 逐串与冻结基准比较。
 * 基准以发起点冻结值为准，不随后续阈值修改或箱内均值漂移而变化，避免同一串时好时坏。
 */

/** 批次状态：进行中 / 已完成（全部串恢复后人工确认结束） */
export type RetestBatchState = 'ongoing' | 'finished';

export const RETEST_BATCH_STATE_LABEL: Record<RetestBatchState, string> = {
  ongoing: '进行中',
  finished: '已结束',
};

/** 冻结基准时参与均值的最近读数条数（不足则不允许发起） */
export const BASELINE_WINDOW_SIZE = 8;

/** 批次内每串至少归入的新读数条数，达到后才做恢复判定 */
export const MIN_BATCH_SAMPLES = 2;

/** 冻结基准使用的归一化辐照度口径（随基准一并冻结，避免后来改阈值影响判定） */
export const FROZEN_STANDARD_IRRADIANCE = 1000;

/** 批次内单串进展 */
export interface RetestStringProgress {
  stringId: string;
  /** 发起点冻结的最近 8 条归一化电流均值（A） */
  frozenBaselineA: number;
  /** 冻结时该串历史读数条数（用于发起页核对） */
  historySampleCount: number;
  /** 归入本批次的读数 id（新读数自动归入，补录的旧读数不算恢复进度） */
  batchSampleIds: string[];
  /** 批次读数的归一化电流均值（A），不足 2 条时为 null */
  batchAvgA: number | null;
  /** 是否恢复：批次均值 ≥ 冻结基准 × 95%，不足 2 条时为 null */
  recovered: boolean | null;
  /** 未恢复 / 待复测原因文案（已恢复为空串） */
  reason: string;
}

/** 整箱复测批次 */
export interface RetestBatch {
  id: string;
  /** 所属逆变器（汇流箱归属在逆变器下） */
  inverterId: string;
  /** 汇流箱编号 */
  combinerBox: string;
  state: RetestBatchState;
  /** 发起时间 ISO（同时作为新旧读数分界：sampledAt 晚于该时刻的读数才归入批次） */
  startedAt: string;
  /** 发起时间的 yyyy-MM-dd HH:mm 口径，作为读数归入批次的比较边界 */
  cutoffSampledAt: string;
  /** 发起时登记的责任人 */
  owner: string;
  /** 恢复比例阈值（发起时固定为 0.95，不随后续阈值修改变化） */
  recoverRatio: number;
  /** 冻结时使用的标准辐照度（发起时固定） */
  standardIrradiance: number;
  /** 逐串冻结基准与进展 */
  strings: RetestStringProgress[];
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 发起批次时的入参 */
export interface RetestBatchDraft {
  inverterId: string;
  combinerBox: string;
  owner: string;
}

/** 批次视图行（带设备 / 电站上下文与整箱进度） */
export interface RetestBatchRow extends RetestBatch, Revisioned {
  boxKey: string;
  inverterModel: string;
  arrayId: string;
  arrayCode: string;
  plantId: string;
  plantName: string;
  stringCount: number;
  recoveredCount: number;
  /** 已凑齐批次最少条数的串数 */
  measuredCount: number;
  /** 是否全部恢复（确认结束的前置条件） */
  allRecovered: boolean;
}

/** 发起前的串校验结果：历史不足 8 条的串挡住发起 */
export interface RetestEligibility {
  /** 同箱是否已有进行中的批次 */
  hasActiveBatch: boolean;
  activeBatchId: string | null;
  /** 历史读数达到 8 条的串 */
  ready: Array<{ stringId: string; code: string; historyCount: number; baselineA: number }>;
  /** 历史不足 8 条的串（挡住发起） */
  insufficient: Array<{ stringId: string; code: string; historyCount: number }>;
  /** 是否允许发起：无进行中批次、箱内有串且全部串历史达标 */
  canStart: boolean;
}
