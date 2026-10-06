/**
 * 整箱复测批次判定（纯函数）
 * - 冻结基准：发起点取每串最近 8 条归一化电流均值（按发起时固定的标准辐照度归一化）
 * - 读数归入批次：sampledAt 严格晚于发起边界的读数（补录的旧读数不计入，进度保持未完成）
 * - 恢复判定：每串至少 2 条批次读数，且批次均值 ≥ 冻结基准 × 95%
 * 基准只认发起点冻结值，不复测时箱内均值、不读后来改过的阈值。
 */
import { DEFAULT_THRESHOLDS } from '../types/settings';
import type { Sample } from '../types/sample';
import type { PvString } from '../types/string';
import {
  BASELINE_WINDOW_SIZE,
  FROZEN_STANDARD_IRRADIANCE,
  MIN_BATCH_SAMPLES,
  type RetestBatch,
  type RetestEligibility,
  type RetestStringProgress,
} from '../types/retest';
import { mean, normalizeCurrent } from './discrete';
import { round } from './format';

/** 汇流箱分组键 */
export function retestBoxKey(inverterId: string, combinerBox: string): string {
  return `${inverterId}::${combinerBox}`;
}

/** 按发起时冻结的标准辐照度口径做归一化 */
function frozenNormalized(currentA: number, irradianceWm2: number, standardIrradiance: number): number {
  return normalizeCurrent(currentA, irradianceWm2, {
    ...DEFAULT_THRESHOLDS,
    standardIrradiance,
  });
}

/** 取某串最近若干条读数（按采样时间升序后取尾部） */
function latestSamples(samples: Sample[], size: number): Sample[] {
  return [...samples].sort((a, b) => a.sampledAt.localeCompare(b.sampledAt)).slice(-size);
}

/** 冻结基准：最近 8 条归一化电流均值 */
export function freezeBaseline(samples: Sample[], standardIrradiance: number): number {
  const window = latestSamples(samples, BASELINE_WINDOW_SIZE);
  const values = window.map((item) => frozenNormalized(item.currentA, item.irradianceWm2, standardIrradiance));
  return round(mean(values), 3);
}

/** 未恢复 / 待复测原因（已恢复或无法判定时按状态返回文案） */
export function unrecoveredReason(input: {
  batchCount: number;
  baselineA: number;
  batchAvgA: number | null;
  recovered: boolean | null;
  stringExists: boolean;
}): string {
  if (!input.stringExists) return '组串已从台账删除，无法复测';
  if (input.batchCount < MIN_BATCH_SAMPLES) {
    return `复测读数不足（${input.batchCount}/${MIN_BATCH_SAMPLES} 条）`;
  }
  if (input.baselineA <= 0 || input.batchAvgA === null) return '冻结基准异常，无法判定';
  if (input.recovered === false) {
    const needA = round(input.baselineA * 0.95, 2);
    return `批次均值 ${input.batchAvgA.toFixed(2)} A，低于冻结基准 ${input.baselineA.toFixed(
      2,
    )} A 的 95%（需 ≥ ${needA.toFixed(2)} A）`;
  }
  return '';
}

/**
 * 依据当前全部读数重算批次内每串进展（不修改入参，返回新批次）。
 * 批次读数 = sampledAt 严格晚于发起边界的读数；补录旧读数不会推进进度。
 */
export function evaluateBatch(batch: RetestBatch, allSamples: Sample[], existingStringIds: Set<string>): RetestBatch {
  const strings: RetestStringProgress[] = batch.strings.map((frozen) => {
    const batchSamples = allSamples
      .filter(
        (item) =>
          item.stringId === frozen.stringId &&
          // 严格晚于发起边界：同一时刻补录的旧读数不算批次读数
          item.sampledAt.localeCompare(batch.cutoffSampledAt) > 0,
      )
      .sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));

    const values = batchSamples.map((item) =>
      frozenNormalized(item.currentA, item.irradianceWm2, batch.standardIrradiance),
    );
    const count = batchSamples.length;
    const batchAvgA = count >= MIN_BATCH_SAMPLES ? round(mean(values), 3) : null;
    const stringExists = existingStringIds.has(frozen.stringId);
    let recovered: boolean | null = null;
    if (!stringExists) {
      // 组串已删除：强制未恢复，批次不能确认结束（removeString 通常会先从批次剔除该串）
      recovered = false;
    } else if (batchAvgA !== null && frozen.frozenBaselineA > 0) {
      recovered = batchAvgA >= frozen.frozenBaselineA * batch.recoverRatio;
    }

    return {
      ...frozen,
      batchSampleIds: batchSamples.map((item) => item.id),
      batchAvgA,
      recovered,
      reason: unrecoveredReason({
        batchCount: count,
        baselineA: frozen.frozenBaselineA,
        batchAvgA,
        recovered,
        stringExists,
      }),
    };
  });

  return { ...batch, strings };
}

/** 批次是否全部恢复（进行中批次确认结束的前置条件） */
export function isBatchAllRecovered(batch: RetestBatch): boolean {
  return (
    batch.strings.length > 0 && batch.strings.every((item) => item.recovered === true && item.reason === '')
  );
}

/** 已恢复串数 */
export function recoveredCountOf(batch: RetestBatch): number {
  return batch.strings.filter((item) => item.recovered === true).length;
}

/** 已凑齐最少批次条数的串数 */
export function measuredCountOf(batch: RetestBatch): number {
  return batch.strings.filter((item) => item.batchSampleIds.length >= MIN_BATCH_SAMPLES).length;
}

/**
 * 发起前校验：列出历史不足 8 条的串（挡住发起），并检查同箱是否已有进行中批次。
 */
export function checkRetestEligibility(input: {
  inverterId: string;
  combinerBox: string;
  boxStrings: PvString[];
  samplesOfString: (stringId: string) => Sample[];
  activeBatchOfBox: (boxKey: string) => RetestBatch | undefined;
}): RetestEligibility {
  const key = retestBoxKey(input.inverterId, input.combinerBox);
  const active = input.activeBatchOfBox(key);
  const ready: RetestEligibility['ready'] = [];
  const insufficient: RetestEligibility['insufficient'] = [];

  for (const string of input.boxStrings) {
    const history = input.samplesOfString(string.id);
    if (history.length < BASELINE_WINDOW_SIZE) {
      insufficient.push({ stringId: string.id, code: string.code, historyCount: history.length });
    } else {
      ready.push({
        stringId: string.id,
        code: string.code,
        historyCount: history.length,
        baselineA: freezeBaseline(history, FROZEN_STANDARD_IRRADIANCE),
      });
    }
  }

  return {
    hasActiveBatch: Boolean(active),
    activeBatchId: active?.id ?? null,
    canStart: !active && input.boxStrings.length > 0 && insufficient.length === 0,
    ready,
    insufficient,
  };
}
