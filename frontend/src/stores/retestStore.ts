/**
 * 整箱复测批次状态（Zustand）
 * 维护复测批次的发起（冻结基准）、列表、进度派生与确认结束。
 * 进度不入库：批次内新读数变化时（采集页录入 / 补录 / 删除）实时由冻结基准派生，
 * 但基准本身一经冻结不再重算，也不读取后来改过的阈值配置。
 */
import { create } from 'zustand';
import {
  ROW_REVISION,
  listRetestBatches,
  listSamples,
  listStrings,
  listInverters,
  listArrays,
  listPlants,
  getThresholds,
  putRetestBatch,
  removeRetestBatch,
  type RetestBatchRow,
  type SampleRow,
  type StringRow,
  type InverterRow,
  type ArrayRow,
  type PlantRow,
} from '../utils/db';
import {
  RETEST_CLEAR_RATIO,
  type RetestBatchDraft,
  type RetestBatchView,
  type RetestPrecheck,
} from '../types/retest';
import { buildBaselines, evaluateStrings, reasonSummaryOf, runPrecheck } from '../utils/retest';
import { nowIso, formatDateTime, uuid } from '../utils/format';
import { emitChange, subscribeChange } from '../utils/events';

interface RetestStoreState {
  batches: RetestBatchRow[];
  samples: SampleRow[];
  strings: StringRow[];
  inverters: InverterRow[];
  arrays: ArrayRow[];
  plants: PlantRow[];
  /** 当前生效标准辐照度（仅用于发起时冻结，已冻结批次不受后续修改影响） */
  standardIrradiance: number;
  loading: boolean;
  error: string;
  loadBatches: () => Promise<void>;
  subscribe: () => void;
  /** 发起预检：返回历史不足串列表 / 同箱进行中批次等信息，不通过则由页面挡住发起 */
  precheck: (inverterId: string, combinerBox: string) => Promise<RetestPrecheck>;
  /** 发起整箱复测（内部再跑一次预检兜底） */
  startBatch: (draft: RetestBatchDraft) => Promise<RetestBatchRow>;
  /** 全部恢复后确认结束；仍有未恢复串时拒绝 */
  finishBatch: (batchId: string) => Promise<boolean>;
  deleteBatch: (batchId: string) => Promise<void>;
  views: () => RetestBatchView[];
  viewOf: (batchId: string) => RetestBatchView | null;
  runningBatches: () => RetestBatchRow[];
  /** 某汇流箱是否有进行中批次 */
  hasRunningForBox: (inverterId: string, combinerBox: string) => boolean;
}

/** 把批次拼成带设备上下文与逐串进度的视图行 */
function hydrateView(
  batch: RetestBatchRow,
  samples: SampleRow[],
  strings: StringRow[],
  inverters: InverterRow[],
  arrays: ArrayRow[],
  plants: PlantRow[],
): RetestBatchView {
  const inverter = inverters.find((item) => item.id === batch.inverterId);
  const array = inverter ? arrays.find((item) => item.id === inverter.arrayId) : undefined;
  const plant = array ? plants.find((item) => item.id === array.plantId) : undefined;
  const codeOf = (stringId: string): string =>
    strings.find((item) => item.id === stringId)?.code ?? '已删除组串';
  const progress = evaluateStrings(batch, samples, codeOf);
  const recoveredCount = progress.filter((item) => item.recovered).length;
  const totalCount = progress.length;
  return {
    ...batch,
    revision: batch.revision ?? ROW_REVISION,
    plantId: plant?.id ?? '',
    plantName: plant?.name ?? '未归属电站',
    arrayId: array?.id ?? '',
    arrayCode: array?.code ?? '-',
    inverterModel: inverter?.model ?? '-',
    totalCount,
    recoveredCount,
    progressPercent: totalCount > 0 ? Number(((recoveredCount / totalCount) * 100).toFixed(1)) : 0,
    allRecovered: totalCount > 0 && recoveredCount === totalCount,
    strings: progress,
    reasonSummary: reasonSummaryOf(progress),
  };
}

let unsubscribed: (() => void) | null = null;

export const useRetestStore = create<RetestStoreState>((set, get) => ({
  batches: [],
  samples: [],
  strings: [],
  inverters: [],
  arrays: [],
  plants: [],
  standardIrradiance: 1000,
  loading: false,
  error: '',

  async loadBatches() {
    set({ loading: true });
    try {
      const [batches, samples, strings, inverters, arrays, plants, thresholdRow] = await Promise.all([
        listRetestBatches(),
        listSamples(),
        listStrings(),
        listInverters(),
        listArrays(),
        listPlants(),
        getThresholds(),
      ]);
      set({
        batches,
        samples,
        strings,
        inverters,
        arrays,
        plants,
        standardIrradiance: thresholdRow.standardIrradiance,
        loading: false,
        error: '',
      });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : '复测批次读取失败' });
    }
  },

  subscribe() {
    if (unsubscribed) return;
    // 采集 / 设备 / 批次任何变化都重算进度（含补录旧读数——只是不会计入时间窗）
    unsubscribed = subscribeChange(() => {
      void get().loadBatches();
    });
  },

  async precheck(inverterId, combinerBox) {
    const state = get();
    return runPrecheck({
      inverterId,
      combinerBox,
      strings: state.strings,
      samples: state.samples,
      runningBatches: state.batches.filter((item) => item.state === 'running'),
      standardIrradiance: state.standardIrradiance,
    });
  },

  async startBatch(draft) {
    const state = get();
    const check = runPrecheck({
      inverterId: draft.inverterId,
      combinerBox: draft.combinerBox,
      strings: state.strings,
      samples: state.samples,
      runningBatches: state.batches.filter((item) => item.state === 'running'),
      standardIrradiance: state.standardIrradiance,
    });
    if (!check.canStart) {
      throw new Error(check.blockReason || '当前不满足发起整箱复测的条件');
    }
    const boxStrings = state.strings
      .filter((item) => item.inverterId === draft.inverterId && item.combinerBox === draft.combinerBox)
      .sort((a, b) => a.code.localeCompare(b.code));
    const stamp = nowIso();
    // 冻结：基准、标准辐照度、95% 比例在发起瞬间定型，后续永不重算
    const row: RetestBatchRow = {
      id: uuid(),
      inverterId: draft.inverterId,
      combinerBox: draft.combinerBox,
      stringIds: boxStrings.map((item) => item.id),
      baselines: buildBaselines(boxStrings, state.samples, state.standardIrradiance),
      state: 'running',
      frozenAt: stamp,
      frozenSampledAt: formatDateTime(new Date()),
      owner: draft.owner.trim(),
      standardIrradiance: state.standardIrradiance,
      clearRatio: RETEST_CLEAR_RATIO,
      finishedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putRetestBatch(row);
    // 同步写入内存：putRetestBatch 触发的订阅 reload 是异步的，
    // 不先更新 state 会让紧随其后的发起/预检读到旧批次集合（互斥失效）
    set((state) => ({ batches: [row, ...state.batches] }));
    emitChange();
    return row;
  },

  async finishBatch(batchId) {
    const existing = get().batches.find((item) => item.id === batchId);
    if (!existing || existing.state !== 'running') return false;
    const view = hydrateView(
      existing,
      get().samples,
      get().strings,
      get().inverters,
      get().arrays,
      get().plants,
    );
    if (!view.allRecovered) return false;
    const stamp = nowIso();
    const finished: RetestBatchRow = { ...existing, state: 'finished', finishedAt: stamp, updatedAt: stamp };
    await putRetestBatch(finished);
    set((state) => ({
      batches: state.batches.map((item) => (item.id === batchId ? finished : item)),
    }));
    emitChange();
    return true;
  },

  async deleteBatch(batchId) {
    await removeRetestBatch(batchId);
    set((state) => ({ batches: state.batches.filter((item) => item.id !== batchId) }));
    emitChange();
  },

  views() {
    const { batches, samples, strings, inverters, arrays, plants } = get();
    return batches.map((batch) => hydrateView(batch, samples, strings, inverters, arrays, plants));
  },

  viewOf(batchId) {
    return get().views().find((item) => item.id === batchId) ?? null;
  },

  runningBatches() {
    return get().batches.filter((item) => item.state === 'running');
  },

  hasRunningForBox(inverterId, combinerBox) {
    return get().batches.some(
      (item) => item.state === 'running' && item.inverterId === inverterId && item.combinerBox === combinerBox,
    );
  },
}));
