/**
 * 整箱复测批次
 * 一个汇流箱内多串同时偏离时，按整箱发起一次复测：
 * 发起瞬间冻结每串「最近 8 条归一化电流」的均值作为基准，
 * 发起之后录入的新读数自动归入本批次，每串至少 2 条且均值达到冻结基准 95% 才算恢复。
 * 基准一经冻结不再变动——不随复测时箱内均值漂移，也不随后来改过的阈值变化，
 * 否则同一串会出现「时好时坏」。
 */
import type { Revisioned } from './persistence';

/** 批次状态：进行中 / 已结束 */
export type RetestBatchState = 'running' | 'finished';

export const RETEST_BATCH_STATE_LABEL: Record<RetestBatchState, string> = {
  running: '进行中',
  finished: '已结束',
};

/** 冻结基准：每串一条，发起时定型，后续永不重算 */
export interface RetestBaseline {
  stringId: string;
  /** 冻结时最近 8 条归一化电流的均值（A） */
  baselineCurrentA: number;
  /** 冻结时参与计算的历史读数条数（发起校验要求 = BASELINE_SAMPLE_COUNT） */
  sampleCount: number;
}

/** 整箱复测批次 */
export interface RetestBatch {
  id: string;
  /** 归属逆变器 */
  inverterId: string;
  /** 汇流箱编号 */
  combinerBox: string;
  /** 本批次覆盖的组串（发起时箱内全部组串快照） */
  stringIds: string[];
  /** 冻结基准，逐串定型 */
  baselines: RetestBaseline[];
  state: RetestBatchState;
  /** 发起时间 ISO */
  frozenAt: string;
  /** 批次读数归属时间窗起点（yyyy-MM-dd HH:mm，与 Sample.sampledAt 同格式可直接比较）；
   *  补录更早的旧读数不会归入本批次，保证补录旧读数后结果仍保持未完成 */
  frozenSampledAt: string;
  /** 发起时登记的发起说明（如操作人） */
  owner: string;
  /** 冻结时的标准辐照度（W/m²），批次内新读数用它做归一化，防止后来改阈值改变判定 */
  standardIrradiance: number;
  /** 冻结时的恢复比例（0.95），同样定型 */
  clearRatio: number;
  /** 确认结束时间 ISO */
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 发起整箱复测的入参草稿 */
export interface RetestBatchDraft {
  inverterId: string;
  combinerBox: string;
  owner: string;
}

/** 单串未恢复原因 */
export type RetestStringReason = 'collecting' | 'below-baseline' | 'recovered';

export const RETEST_STRING_REASON_LABEL: Record<RetestStringReason, string> = {
  collecting: '新读数不足 2 条',
  'below-baseline': '均值未达冻结基准 95%',
  recovered: '已恢复',
};

/** 组串维度的实时进度（由批次 + 批次内读数派生，不持久化） */
export interface RetestStringProgress {
  stringId: string;
  /** 冻结基准电流（A） */
  baselineCurrentA: number;
  /** 归入本批次的新读数条数（sampledAt ≥ frozenAt） */
  batchSampleCount: number;
  /** 批次内新读数的归一化电流均值（A），不足 1 条为 0 */
  batchAvgCurrentA: number;
  /** 批次均值 / 冻结基准（%） */
  ratioPercent: number;
  /** 该串是否恢复：≥2 条新读数且均值达到冻结基准 95% */
  recovered: boolean;
  /** 未恢复原因（恢复后为 recovered） */
  reason: RetestStringReason;
}

/** 批次视图行：拼接设备上下文与逐串进度，供排查台、处置单页共用 */
export interface RetestBatchView extends RetestBatch, Revisioned {
  plantId: string;
  plantName: string;
  arrayId: string;
  arrayCode: string;
  inverterModel: string;
  /** 批次覆盖组串总数 */
  totalCount: number;
  /** 已恢复组串数 */
  recoveredCount: number;
  /** 恢复进度（%） */
  progressPercent: number;
  /** 全部组串均已恢复（结束按钮的唯一可用条件） */
  allRecovered: boolean;
  /** 逐串进度，按组串编号排序 */
  strings: RetestStringProgress[];
  /** 未恢复原因汇总（进行中批次展示，如「2 串读数不足、1 串未达基准」） */
  reasonSummary: string;
}

/** 发起整箱复测时的预检结果 */
export interface RetestPrecheck {
  inverterId: string;
  combinerBox: string;
  /** 箱内组串总数 */
  totalCount: number;
  /** 历史读数满足冻结条件的组串 */
  ready: Array<{ stringId: string; sampleCount: number; baselineCurrentA: number }>;
  /** 历史不足最近 8 条的组串（非空则必须挡住发起） */
  insufficient: Array<{ stringId: string; sampleCount: number }>;
  /** 同箱是否已有进行中的批次（为 true 时必须挡住发起，先结束上一批） */
  hasRunning: boolean;
  /** 是否允许发起 */
  canStart: boolean;
  /** 不可发起的说明 */
  blockReason: string;
}

/** 冻结基准使用的历史读数窗口条数：最近 8 条 */
export const BASELINE_SAMPLE_COUNT = 8;

/** 每串恢复所需的批次内最少新读数条数 */
export const MIN_BATCH_SAMPLE_COUNT = 2;

/** 恢复比例：批次均值达到冻结基准的 95% */
export const RETEST_CLEAR_RATIO = 0.95;
