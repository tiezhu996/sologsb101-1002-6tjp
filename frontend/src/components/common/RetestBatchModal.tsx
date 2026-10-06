/**
 * 整箱复测批次发起 / 跟踪弹窗
 * - 发起前冻结每串最近 8 条归一化电流均值，历史不足的串列出并挡住发起
 * - 同箱已有进行中批次时提示先结束上一批
 * - 发起后展示每串批次读数进度、冻结基准、批次均值与未恢复原因
 * - 全部恢复后可确认结束；补录旧读数不推进进度
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Descriptions,
  Empty,
  Input,
  Modal,
  Progress,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { useRetestStore, DEFAULT_RETEST_OWNER } from '../../stores/retestStore';
import { useDeviceStore } from '../../stores/deviceStore';
import { useSampleStore } from '../../stores/sampleStore';
import {
  BASELINE_WINDOW_SIZE,
  MIN_BATCH_SAMPLES,
  type RetestBatchRow,
  type RetestEligibility,
} from '../../types/retest';
import { formatCurrent } from '../../utils/unit';

interface Props {
  open: boolean;
  inverterId: string;
  combinerBox: string;
  onClose: () => void;
}

export default function RetestBatchModal({ open, inverterId, combinerBox, onClose }: Props) {
  const { message } = AntdApp.useApp();
  const strings = useDeviceStore((state) => state.strings);
  const samples = useSampleStore((state) => state.samples);
  const eligibility = useRetestStore((state) => state.eligibility);
  const startBatch = useRetestStore((state) => state.startBatch);
  const finishBatch = useRetestStore((state) => state.finishBatch);
  const activeBatchOfBox = useRetestStore((state) => state.activeBatchOfBox);
  const rowOf = useRetestStore((state) => state.rowOf);
  const [owner, setOwner] = useState(DEFAULT_RETEST_OWNER);
  const [submitting, setSubmitting] = useState(false);

  const boxStrings = useMemo(
    () =>
      strings
        .filter((item) => item.inverterId === inverterId && item.combinerBox === combinerBox)
        .sort((a, b) => a.code.localeCompare(b.code)),
    [strings, inverterId, combinerBox],
  );

  const check: RetestEligibility | null = useMemo(() => {
    if (!open || !inverterId || !combinerBox) return null;
    return eligibility(inverterId, combinerBox);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, inverterId, combinerBox, eligibility, strings, samples]);

  const activeDb = activeBatchOfBox(inverterId, combinerBox);
  const active: RetestBatchRow | null = activeDb ? rowOf(activeDb.id) : null;

  useEffect(() => {
    if (open) setOwner(DEFAULT_RETEST_OWNER);
  }, [open, inverterId, combinerBox]);

  const handleStart = async (): Promise<void> => {
    if (!check) return;
    if (check.hasActiveBatch) {
      message.warning('同箱已有进行中的批次，请先结束上一批');
      return;
    }
    if (!owner.trim()) {
      message.warning('请填写责任人');
      return;
    }
    if (!check.canStart) return;
    setSubmitting(true);
    try {
      await startBatch({ inverterId, combinerBox, owner });
      message.success('已发起整箱复测，每串基准已按最近 8 条归一化电流均值冻结');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发起失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleFinish = async (): Promise<void> => {
    if (!active) return;
    const ok = await finishBatch(active.id);
    if (ok) message.success('全部组串已恢复，批次确认结束');
    else message.warning('仍有组串未恢复，不能结束批次');
  };

  const title = `整箱复测 · ${combinerBox || '未选择汇流箱'}`;

  return (
    <Modal
      title={
        <Space>
          <LockOutlined />
          {title}
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={920}
      footer={
        active ? (
          <Space>
            <Button onClick={onClose}>关闭</Button>
            <Button type="primary" disabled={!active.allRecovered} onClick={() => void handleFinish()}>
              确认结束批次
            </Button>
          </Space>
        ) : (
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button
              type="primary"
              loading={submitting}
              disabled={!check?.canStart || !owner.trim()}
              onClick={() => void handleStart()}
            >
              冻结基准并发起
            </Button>
          </Space>
        )
      }
    >
      {boxStrings.length === 0 ? (
        <Empty description="该汇流箱下暂无组串" />
      ) : active ? (
        <ActiveBatchView
          batch={active}
          codeOf={(id) => boxStrings.find((item) => item.id === id)?.code ?? '已删除组串'}
        />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {check?.hasActiveBatch ? (
            <Alert
              type="warning"
              showIcon
              message="同箱已有进行中的复测批次"
              description="请先结束上一批后，再发起新的整箱复测。"
            />
          ) : null}

          <Alert
            type="info"
            showIcon
            message="发起即冻结基准"
            description={
              <span>
                冻结每串最近 <b>{BASELINE_WINDOW_SIZE}</b> 条归一化电流均值作为基准；发起后只有采集时间晚于发起时刻的新读数会归入批次，每串至少{' '}
                <b>{MIN_BATCH_SAMPLES}</b> 条、批次均值达到冻结基准的 <b>95%</b> 才算恢复。基准不随后续阈值修改或箱内均值漂移变化。
              </span>
            }
          />

          <Space size={12} wrap>
            <span>责任人：</span>
            <Input value={owner} onChange={(event) => setOwner(event.target.value)} style={{ width: 200 }} />
            <Typography.Text type="secondary">箱内组串 {boxStrings.length} 串</Typography.Text>
          </Space>

          {check && check.insufficient.length > 0 ? (
            <Alert
              type="error"
              showIcon
              message={`${check.insufficient.length} 串历史读数不足 ${BASELINE_WINDOW_SIZE} 条，已挡住发起`}
              description={
                <Space wrap size={[4, 4]}>
                  {check.insufficient.map((item) => (
                    <Tag key={item.stringId} color="red">
                      {item.code}（仅 {item.historyCount} 条）
                    </Tag>
                  ))}
                </Space>
              }
            />
          ) : null}

          <Table
            rowKey="stringId"
            size="small"
            pagination={false}
            dataSource={check?.ready ?? []}
            columns={[
              { title: '组串', dataIndex: 'code', width: 120 },
              {
                title: '历史读数',
                dataIndex: 'historyCount',
                width: 100,
                render: (v: number) => `${v} 条`,
              },
              {
                title: `冻结基准（近 ${BASELINE_WINDOW_SIZE} 条归一化均值）`,
                dataIndex: 'baselineA',
                render: (value: number) => formatCurrent(value),
              },
              {
                title: '校验',
                width: 120,
                render: (_, row) =>
                  row.historyCount >= BASELINE_WINDOW_SIZE ? (
                    <Tag color="success">可冻结</Tag>
                  ) : (
                    <Tag color="error">不足</Tag>
                  ),
              },
            ]}
          />
        </Space>
      )}
    </Modal>
  );
}

/** 进行中批次的进展明细 */
function ActiveBatchView({
  batch,
  codeOf,
}: {
  batch: RetestBatchRow;
  codeOf: (stringId: string) => string;
}) {
  const percent =
    batch.stringCount === 0 ? 0 : Math.round((batch.recoveredCount / batch.stringCount) * 100);
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Descriptions size="small" column={3} bordered>
        <Descriptions.Item label="责任人">{batch.owner}</Descriptions.Item>
        <Descriptions.Item label="发起时刻">{batch.cutoffSampledAt}</Descriptions.Item>
        <Descriptions.Item label="恢复比例阈值">95%（发起时冻结）</Descriptions.Item>
        <Descriptions.Item label="已测 / 总数">
          {batch.measuredCount} / {batch.stringCount} 串
        </Descriptions.Item>
        <Descriptions.Item label="已恢复">{batch.recoveredCount} 串</Descriptions.Item>
        <Descriptions.Item label="状态">
          <Tag color="processing">进行中</Tag>
        </Descriptions.Item>
      </Descriptions>

      <Progress
        percent={percent}
        status={batch.allRecovered ? 'success' : 'active'}
        format={(value) => `恢复 ${value}%`}
      />
      {batch.allRecovered ? (
        <Alert type="success" showIcon message="全部组串均已恢复，可确认结束批次。" />
      ) : (
        <Alert
          type="warning"
          showIcon
          message="尚有组串未恢复，批次保持未完成"
          description="仅采集时间晚于发起时刻的新读数计入批次；补录旧读数不会推进进度。"
        />
      )}

      <Table
        rowKey="stringId"
        size="small"
        pagination={false}
        dataSource={batch.strings}
        columns={[
          { title: '组串', width: 110, render: (_, row) => codeOf(row.stringId) },
          {
            title: '冻结基准',
            dataIndex: 'frozenBaselineA',
            width: 110,
            render: (value: number) => formatCurrent(value),
          },
          {
            title: `批次读数（≥${MIN_BATCH_SAMPLES} 条）`,
            width: 140,
            render: (_, row) => `${row.batchSampleIds.length} 条`,
          },
          {
            title: '批次均值',
            dataIndex: 'batchAvgA',
            width: 110,
            render: (value: number | null) => (value === null ? '—' : formatCurrent(value)),
          },
          {
            title: '状态 / 未恢复原因',
            render: (_, row) =>
              row.recovered === true ? (
                <Tag color="success">已恢复</Tag>
              ) : (
                <Space size={6}>
                  <Tag color={row.batchSampleIds.length >= MIN_BATCH_SAMPLES ? 'error' : 'default'}>
                    {row.recovered === false ? '未恢复' : '待复测'}
                  </Tag>
                  <Typography.Text type="secondary">{row.reason}</Typography.Text>
                </Space>
              ),
          },
        ]}
      />
    </Space>
  );
}
