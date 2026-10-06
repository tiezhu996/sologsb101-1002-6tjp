/**
 * 整箱复测纯逻辑
 * - 发起预检：校验同箱是否有进行中批次、每串最近 8 条历史读数是否齐备
 * - 冻结基准：最近 8 条读数按发起时的标准辐照度归一化后取均值
 * - 批次归属：sampledAt >= frozenAt 的读数才归入批次（补录更早的旧读数不计入）
 * - 恢复判定：每串批次内 ≥2 条读数、归一化均值 ≥ 冻结基准 × 95%
 * 全部为纯函数，被 retestStore、预检弹窗与进度抽屉共用。
 */
import type { PvString } from '../types/string';
import type { Sample } from '../types/sample';
import type {
  RetestBaseline,
  RetestBatch,
  RetestPrecheck,
  RetestStringProgress,
  RetestStringReason,
} from '../types/retest';
import {
  BASELINE_SAMPLE_COUNT,
  MIN_BATCH_SAMPLE_COUNT,
  RETEST_CLEAR_RATIO,
} from '../types/retest';
import { mean } from './discrete';
import { round } from './format';

/** 按指定标准辐照度做电流归一化（与 utils/discrete.normalizeCurrent 同口径，但显式传参） */
export function normalizeWithStandard(
  currentA: number,
  irradianceWm2: number,
  standardIrradiance: number,
): number {
  if (irradianceWm2 <= 0 || standardIrradiance <= 0) return round(currentA, 3);
  const ratio = standardIrradiance / irradianceWm2;
  // 辐照度极低时归一化会放大噪声，限制修正倍数上限为 2
  return round(currentA * Math.min(ratio, 2), 3);
}

/** 取某组串按采集时间升序的读数（归一化口径外部决定） */
function sortedSamplesOf(samples: Sample[], stringId: string): Sample[] {
  return samples
    .filter((item) => item.stringId === stringId)
    .sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
}

/** 计算发起冻结时某串的基准：最近 8 条读数的归一化均值 */
export function freezeBaseline(
  samples: Sample[],
  stringId: string,
  standardIrradiance: number,
): { baselineCurrentA: number; sampleCount: number } {
  const history = sortedSamplesOf(samples, stringId).slice(-BASELINE_SAMPLE_COUNT);
  const values = history.map((item) =>
    normalizeWithStandard(item.currentA, item.irradianceWm2, standardIrradiance),
  );
  return {
    baselineCurrentA: round(mean(values), 3),
    sampleCount: history.length,
  };
}

/** 生成冻结基准列表（调用前应先通过预检，保证每串都满 8 条） */
export function buildBaselines(
  strings: PvString[],
  samples: Sample[],
  standardIrradiance: number,
): RetestBaseline[] {
  return strings.map((item) => {
    const frozen = freezeBaseline(samples, item.id, standardIrradiance);
    return {
      stringId: item.id,
      baselineCurrentA: frozen.baselineCurrentA,
      sampleCount: frozen.sampleCount,
    };
  });
}

/**
 * 发起预检：
 * 1. 同箱已有进行中批次 → 挡住，要求先结束上一批
 * 2. 箱内任一组串历史读数不足最近 8 条 → 列出这些串并挡住发起
 */
export function runPrecheck(input: {
  inverterId: string;
  combinerBox: string;
  strings: PvString[];
  samples: Sample[];
  runningBatches: RetestBatch[];
  standardIrradiance: number;
}): RetestPrecheck {
  const { inverterId, combinerBox, strings, samples, runningBatches, standardIrradiance } = input;
  const boxStrings = strings
    .filter((item) => item.inverterId === inverterId && item.combinerBox === combinerBox)
    .sort((a, b) => a.code.localeCompare(b.code));

  const hasRunning = runningBatches.some(
    (item) => item.inverterId === inverterId && item.combinerBox === combinerBox,
  );

  const ready: RetestPrecheck['ready'] = [];
  const insufficient: RetestPrecheck['insufficient'] = [];
  for (const item of boxStrings) {
    const frozen = freezeBaseline(samples, item.id, standardIrradiance);
    if (frozen.sampleCount < BASELINE_SAMPLE_COUNT) {
      insufficient.push({ stringId: item.id, sampleCount: frozen.sampleCount });
    } else {
      ready.push({ stringId: item.id, sampleCount: frozen.sampleCount, baselineCurrentA: frozen.baselineCurrentA });
    }
  }

  const reasons: string[] = [];
  if (hasRunning) reasons.push('该汇流箱已有进行中的复测批次，请先结束上一批');
  if (boxStrings.length === 0) reasons.push('该汇流箱下没有组串');
  if (insufficient.length > 0) {
    reasons.push(`${insufficient.length} 串历史读数不足最近 ${BASELINE_SAMPLE_COUNT} 条`);
  }

  return {
    inverterId,
    combinerBox,
    totalCount: boxStrings.length,
    ready,
    insufficient,
    hasRunning,
    canStart: reasons.length === 0,
    blockReason: reasons.join('；'),
  };
}

/** 归入某批次的读数：属于覆盖组串、且采集时间不早于发起点（补录旧读数被排除） */
export function batchSamplesOf(batch: RetestBatch, samples: Sample[]): Sample[] {
  const scope = new Set(batch.stringIds);
  return samples.filter(
    (item) => scope.has(item.stringId) && item.sampledAt.localeCompare(batch.frozenSampledAt) >= 0,
  );
}

/**
 * 依据批次冻结基准 + 当前批次内读数，逐串计算实时进度。
 * 注意：归一化使用批次冻结的标准辐照度，比例使用冻结的 clearRatio，
 * 不读当前阈值配置——后来改阈值不影响本批次判定。
 */
export function evaluateStrings(
  batch: RetestBatch,
  samples: Sample[],
  codeOf: (stringId: string) => string,
): RetestStringProgress[] {
  const grouped = new Map<string, Sample[]>();
  for (const sample of batchSamplesOf(batch, samples)) {
    const list = grouped.get(sample.stringId);
    if (list) list.push(sample);
    else grouped.set(sample.stringId, [sample]);
  }

  return [...batch.baselines]
    .sort((a, b) => codeOf(a.stringId).localeCompare(codeOf(b.stringId), 'zh-Hans-CN'))
    .map((baseline) => {
      const rows = (grouped.get(baseline.stringId) ?? [])
        .slice()
        .sort((a, b) => a.sampledAt.localeCompare(b.sampledAt));
      const values = rows.map((item) =>
        normalizeWithStandard(item.currentA, item.irradianceWm2, batch.standardIrradiance),
      );
      const batchAvg = values.length > 0 ? round(mean(values), 3) : 0;
      const ratioPercent =
        baseline.baselineCurrentA > 0
          ? round((batchAvg / baseline.baselineCurrentA) * 100, 1)
          : 0;
      const enough = rows.length >= MIN_BATCH_SAMPLE_COUNT;
      const reached = ratioPercent >= batch.clearRatio * 100;
      const recovered = enough && reached;
      const reason: RetestStringReason = recovered
        ? 'recovered'
        : enough
          ? 'below-baseline'
          : 'collecting';
      return {
        stringId: baseline.stringId,
        baselineCurrentA: baseline.baselineCurrentA,
        batchSampleCount: rows.length,
        batchAvgCurrentA: batchAvg,
        ratioPercent,
        recovered,
        reason,
      };
    });
}

/** 未恢复原因汇总文案 */
export function reasonSummaryOf(progress: RetestStringProgress[]): string {
  const collecting = progress.filter((item) => item.reason === 'collecting').length;
  const below = progress.filter((item) => item.reason === 'below-baseline').length;
  const parts: string[] = [];
  if (collecting > 0) parts.push(`${collecting} 串新读数不足 ${MIN_BATCH_SAMPLE_COUNT} 条`);
  if (below > 0) parts.push(`${below} 串均值未达冻结基准 ${Math.round(RETEST_CLEAR_RATIO * 100)}%`);
  return parts.length > 0 ? parts.join('；') : '全部组串已恢复，可确认结束';
}
