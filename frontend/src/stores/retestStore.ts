/**
 * 整箱复测批次状态（Zustand）
 * 发起时冻结每串最近 8 条归一化电流均值；之后新读数自动归入批次并重算进展；
 * 每串至少 2 条批次读数且均值 ≥ 冻结基准 95% 才算恢复；全部恢复后可确认结束。
 * 基准以发起点冻结值为准，不使用复测时箱内均值，也不读后来改过的阈值。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  listArrays,
  listInverters,
  listPlants,
  listRetestBatches,
  listSamples,
  listStrings,
  putRetestBatch,
  removeRetestBatch,
  type ArrayRow,
  type InverterRow,
  type PlantRow,
  type RetestBatchRowDb,
  type SampleRow,
  type StringRow,
} from '../utils/db';
import {
  BASELINE_WINDOW_SIZE,
  FROZEN_STANDARD_IRRADIANCE,
  MIN_BATCH_SAMPLES,
  type RetestBatchRow,
  type RetestBatchDraft,
  type RetestEligibility,
} from '../types/retest';
import { CLEAR_RATIO } from '../types/disposal';
import { checkRetestEligibility, evaluateBatch, freezeBaseline, isBatchAllRecovered, retestBoxKey } from '../utils/retest';
import { formatDateTime, nowIso, uuid } from '../utils/format';
import { emitChange, subscribeChange } from '../utils/events';

interface RetestStoreState {
  batches: RetestBatchRowDb[];
  samples: SampleRow[];
  strings: StringRow[];
  inverters: InverterRow[];
  arrays: ArrayRow[];
  plants: PlantRow[];
  loading: boolean;
  error: string;
  loadBatches: () => Promise<void>;
  subscribe: () => void;
  /** 发起前校验：列出历史不足 8 条的串并返回同箱进行中批次 */
  eligibility: (inverterId: string, combinerBox: string) => RetestEligibility;
  /** 发起整箱复测（前置：canStart；不满足时抛错） */
  startBatch: (draft: RetestBatchDraft) => Promise<RetestBatchRowDb>;
  /** 依据当前读数重算全部进行中批次并落库（有进展变化才写） */
  refreshActiveBatches: () => Promise<void>;
  /** 全部恢复后确认结束 */
  finishBatch: (batchId: string) => Promise<boolean>;
  deleteBatch: (batchId: string) => Promise<void>;
  /** 视图行（拼设备/电站上下文与进度统计，响应式派生） */
  rows: () => RetestBatchRow[];
  rowOf: (batchId: string) => RetestBatchRow | null;
  /** 某组串所在的进行中批次（无则 null） */
  activeBatchOfString: (stringId: string) => RetestBatchRowDb | null;
  /** 某汇流箱的进行中批次 */
  activeBatchOfBox: (inverterId: string, combinerBox: string) => RetestBatchRowDb | undefined;
  /** 进行中批次数（侧栏/徽标用） */
  activeCount: () => number;
}

let unsubscribed: (() => void) | null = null;

export const useRetestStore = create<RetestStoreState>((set, get) => ({
  batches: [],
  samples: [],
  strings: [],
  inverters: [],
  arrays: [],
  plants: [],
  loading: false,
  error: '',

  async loadBatches() {
    set({ loading: true });
    try {
      const [batches, samples, strings, inverters, arrays, plants] = await Promise.all([
        listRetestBatches(),
        listSamples(),
        listStrings(),
        listInverters(),
        listArrays(),
        listPlants(),
      ]);
      // 读数可能在其它页补录：加载时先把进行中批次按最新读数重算并落库
      const existingIds = new Set(strings.map((item) => item.id));
      let changed = false;
      const evaluated = batches.map((batch) => {
        if (batch.state !== 'ongoing') return batch;
        const next = evaluateBatch(batch, samples, existingIds);
        if (JSON.stringify(next.strings) !== JSON.stringify(batch.strings)) changed = true;
        return { ...next, updatedAt: nowIso(), revision: ROW_REVISION };
      });
      if (changed) {
        await Promise.all(evaluated.map((batch) => putRetestBatch(batch)));
      }
      set({ batches: evaluated, samples, strings, inverters, arrays, plants, loading: false, error: '' });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '复测批次读取失败' });
    }
  },

  subscribe() {
    if (unsubscribed) return;
    unsubscribed = subscribeChange(() => {
      void get().loadBatches();
    });
  },

  eligibility(inverterId, combinerBox) {
    const { samples, strings } = get();
    const boxStrings = strings
      .filter((item) => item.inverterId === inverterId && item.combinerBox === combinerBox)
      .sort((a, b) => a.code.localeCompare(b.code));
    const samplesOfString = (stringId: string): SampleRow[] =>
      samples.filter((item) => item.stringId === stringId);
    return checkRetestEligibility({
      inverterId,
      combinerBox,
      boxStrings,
      samplesOfString,
      activeBatchOfBox: (key) =>
        get().batches.find(
          (item) => item.state === 'ongoing' && retestBoxKey(item.inverterId, item.combinerBox) === key,
        ),
    });
  },

  async startBatch(draft) {
    const state = get();
    const check = state.eligibility(draft.inverterId, draft.combinerBox);
    if (check.hasActiveBatch) {
      throw new Error('同箱已有进行中的复测批次，请先结束上一批后再发起');
    }
    if (!check.canStart) {
      const names = check.insufficient.map((item) => item.code).join('、');
      throw new Error(
        names
          ? `以下组串最近 ${BASELINE_WINDOW_SIZE} 条历史读数不足，无法发起：${names}`
          : '该汇流箱下暂无可复测组串',
      );
    }
    const stamp = nowIso();
    const cutoff = formatDateTime(new Date());
    const existingIds = new Set(state.strings.map((item) => item.id));
    const batch: RetestBatchRowDb = {
      id: uuid(),
      inverterId: draft.inverterId,
      combinerBox: draft.combinerBox,
      state: 'ongoing',
      startedAt: stamp,
      cutoffSampledAt: cutoff,
      owner: draft.owner.trim(),
      recoverRatio: CLEAR_RATIO,
      standardIrradiance: FROZEN_STANDARD_IRRADIANCE,
      strings: check.ready.map((item) => ({
        stringId: item.stringId,
        frozenBaselineA: item.baselineA,
        historySampleCount: item.historyCount,
        batchSampleIds: [],
        batchAvgA: null,
        recovered: null,
        reason: `复测读数不足（0/${MIN_BATCH_SAMPLES} 条）`,
      })),
      finishedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    // 发起瞬间若已有晚于边界的读数（极端时钟差），也立即归入
    const evaluated = evaluateBatch(batch, state.samples, existingIds);
    await putRetestBatch({ ...evaluated, revision: ROW_REVISION });
    emitChange();
    return { ...evaluated, revision: ROW_REVISION };
  },

  async refreshActiveBatches() {
    const { batches, samples, strings } = get();
    const existingIds = new Set(strings.map((item) => item.id));
    const updates: RetestBatchRowDb[] = [];
    for (const batch of batches) {
      if (batch.state !== 'ongoing') continue;
      const next = evaluateBatch(batch, samples, existingIds);
      if (JSON.stringify(next.strings) !== JSON.stringify(batch.strings)) {
        updates.push({ ...next, updatedAt: nowIso(), revision: ROW_REVISION });
      }
    }
    if (updates.length > 0) {
      await Promise.all(updates.map((batch) => putRetestBatch(batch)));
      emitChange();
    }
  },

  async finishBatch(batchId) {
    const existing = get().batches.find((item) => item.id === batchId);
    if (!existing || existing.state !== 'ongoing') return false;
    if (!isBatchAllRecovered(existing)) return false;
    const stamp = nowIso();
    await putRetestBatch({ ...existing, state: 'finished', finishedAt: stamp, updatedAt: stamp });
    emitChange();
    return true;
  },

  async deleteBatch(batchId) {
    await removeRetestBatch(batchId);
    emitChange();
  },

  rows() {
    const { batches, inverters, arrays, plants } = get();
    return batches.map((batch) => {
      const inverter = inverters.find((item) => item.id === batch.inverterId);
      const array = inverter ? arrays.find((item) => item.id === inverter.arrayId) : undefined;
      const plant = array ? plants.find((item) => item.id === array.plantId) : undefined;
      const recoveredCount = batch.strings.filter((item) => item.recovered === true).length;
      const measuredCount = batch.strings.filter((item) => item.batchSampleIds.length >= MIN_BATCH_SAMPLES).length;
      return {
        ...batch,
        revision: ROW_REVISION,
        boxKey: retestBoxKey(batch.inverterId, batch.combinerBox),
        inverterModel: inverter?.model ?? '-',
        arrayId: array?.id ?? '',
        arrayCode: array?.code ?? '-',
        plantId: plant?.id ?? '',
        plantName: plant?.name ?? '未归属电站',
        stringCount: batch.strings.length,
        recoveredCount,
        measuredCount,
        allRecovered: isBatchAllRecovered(batch),
      };
    });
  },

  rowOf(batchId) {
    return get().rows().find((item) => item.id === batchId) ?? null;
  },

  activeBatchOfString(stringId) {
    return (
      get().batches.find(
        (item) => item.state === 'ongoing' && item.strings.some((row) => row.stringId === stringId),
      ) ?? null
    );
  },

  activeBatchOfBox(inverterId, combinerBox) {
    return get().batches.find(
      (item) =>
        item.state === 'ongoing' &&
        item.inverterId === inverterId &&
        item.combinerBox === combinerBox,
    );
  },

  activeCount() {
    return get().batches.filter((item) => item.state === 'ongoing').length;
  },
}));

/** 发起批次时的默认责任人 */
export const DEFAULT_RETEST_OWNER = '复测班组';

/** 供 UI 展示冻结基准口径 */
export { BASELINE_WINDOW_SIZE, freezeBaseline };
