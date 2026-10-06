/**
 * 整箱复测进度抽屉（失配排查台与处置单页共用）
 * 展示批次冻结基准、恢复进度与每串未恢复原因；
 * 仅当全部组串恢复（≥2 条新读数且均值达冻结基准 95%）时允许确认结束。
 */
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CheckCircleOutlined, LockOutlined } from '@ant-design/icons';
import { useRetestStore } from '../../stores/retestStore';
import { useDeviceStore } from '../../stores/deviceStore';
import {
  RETEST_BATCH_STATE_LABEL,
  RETEST_STRING_REASON_LABEL,
  type RetestBatchView,
  type RetestStringProgress,
} from '../../types/retest';
import { formatCurrent } from '../../utils/unit';

interface RetestProgressDrawerProps {
  batch: RetestBatchView | null;
  onClose: () => void;
  /** 结束批次后回调 */
  onFinished?: (batchId: string) => void;
}

const REASON_TAG_COLOR: Record<RetestStringProgress['reason'], string> = {
  recovered: 'success',
  collecting: 'default',
  'below-baseline': 'error',
};

export default function RetestProgressDrawer({ batch, onClose, onFinished }: RetestProgressDrawerProps) {
  const strings = useDeviceStore((state) => state.strings);
  const finishBatch = useRetestStore((state) => state.finishBatch);
  const deleteBatch = useRetestStore((state) => state.deleteBatch);

  const codeOf = (stringId: string): string =>
    strings.find((item) => item.id === stringId)?.code ?? '已删除组串';

  const running = batch?.state === 'running';

  return (
    <Drawer
      title={
        batch
          ? `整箱复测 · ${batch.combinerBox}（${batch.inverterModel}）`
          : '整箱复测进度'
      }
      width={860}
      open={Boolean(batch)}
      onClose={onClose}
      extra={
        batch ? (
          <Space>
            <Tag color={running ? 'processing' : 'success'}>
              {RETEST_BATCH_STATE_LABEL[batch.state]}
            </Tag>
            {running ? (
              <Popconfirm
                title="确认结束本批次？"
                description="仅全部组串恢复后可结束，结束后该箱可重新发起复测。"
                okText="确认结束"
                cancelText="取消"
                disabled={!batch.allRecovered}
                onConfirm={async () => {
                  const ok = await finishBatch(batch.id);
                  if (ok) {
                    onFinished?.(batch.id);
                  }
                }}
              >
                <Button type="primary" icon={<CheckCircleOutlined />} disabled={!batch.allRecovered}>
                  确认结束
                </Button>
              </Popconfirm>
            ) : (
              <Popconfirm
                title="删除该批次记录？"
                description="仅删除批次与冻结基准，不影响已录入的采集读数。"
                okText="删除"
                cancelText="取消"
                onConfirm={async () => {
                  await deleteBatch(batch.id);
                  onClose();
                }}
              >
                <Button danger type="text">
                  删除批次
                </Button>
              </Popconfirm>
            )}
          </Space>
        ) : null
      }
    >
      {!batch ? (
        <Empty description="未找到批次" />
      ) : (
        <Space direction="vertical" size={14} style={{ width: '100%' }}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="电站 / 方阵">
              {batch.plantName} · {batch.arrayCode}
            </Descriptions.Item>
            <Descriptions.Item label="发起人">{batch.owner}</Descriptions.Item>
            <Descriptions.Item label="发起冻结时间">
              <span className="gb-mono">{batch.frozenSampledAt}</span>
            </Descriptions.Item>
            <Descriptions.Item label="冻结标准辐照度">
              {batch.standardIrradiance} W/m²
            </Descriptions.Item>
            <Descriptions.Item label="恢复口径" span={2}>
              <LockOutlined /> 每串批次内 ≥2 条新读数，归一化均值 ≥ 冻结基准 ×{' '}
              {Math.round(batch.clearRatio * 100)}%（基准发起时冻结，不随后续阈值/箱内均值变化）
            </Descriptions.Item>
            {batch.finishedAt ? (
              <Descriptions.Item label="结束时间" span={2}>
                <span className="gb-mono">{batch.finishedAt.replace('T', ' ').slice(0, 16)}</span>
              </Descriptions.Item>
            ) : null}
          </Descriptions>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <Progress
              type="circle"
              size={84}
              percent={batch.progressPercent}
              format={(value) => `${value?.toFixed(0)}%`}
              strokeColor={batch.allRecovered ? '#237804' : '#d46b08'}
            />
            <div>
              <Typography.Title level={5} style={{ margin: 0 }}>
                恢复进度：{batch.recoveredCount} / {batch.totalCount} 串
              </Typography.Title>
              <Typography.Text type={batch.allRecovered ? 'success' : 'warning'}>
                {running
                  ? batch.allRecovered
                    ? '全部组串已恢复，可确认结束本批次。'
                    : `未恢复原因：${batch.reasonSummary}`
                  : '该批次已结束。'}
              </Typography.Text>
            </div>
          </div>

          {running && !batch.allRecovered ? (
            <Alert
              type="warning"
              showIcon
              message="批次进行中：请到「采集与离散率」按汇流箱录入发起之后的新读数，进度自动更新"
              description="补录发起时间之前的旧读数不会计入本批次，结果仍保持未完成。"
            />
          ) : null}
          {running && batch.allRecovered ? (
            <Alert type="success" showIcon message="全部组串达到冻结基准 95%，可确认结束整箱复测。" />
          ) : null}

          <Table<RetestStringProgress>
            rowKey="stringId"
            size="small"
            pagination={false}
            dataSource={batch.strings}
            columns={[
              {
                title: '组串',
                width: 150,
                render: (_, row) => `${batch.combinerBox} · ${codeOf(row.stringId)}`,
              },
              {
                title: '冻结基准（A）',
                dataIndex: 'baselineCurrentA',
                width: 120,
                render: (value: number) => <span className="gb-mono">{formatCurrent(value)}</span>,
              },
              {
                title: '批次新读数',
                dataIndex: 'batchSampleCount',
                width: 110,
                render: (value: number) => (
                  <Tag color={value >= 2 ? 'blue' : 'default'}>{value} 条</Tag>
                ),
              },
              {
                title: '批次均值（A）',
                dataIndex: 'batchAvgCurrentA',
                width: 120,
                render: (value: number) => (value > 0 ? formatCurrent(value) : <span className="gb-hint">—</span>),
              },
              {
                title: '达基准比例',
                dataIndex: 'ratioPercent',
                width: 120,
                render: (value: number, row) => (
                  <Typography.Text
                    type={row.recovered ? 'success' : row.reason === 'below-baseline' ? 'danger' : undefined}
                  >
                    {value > 0 ? `${value.toFixed(1)}%` : '—'}
                  </Typography.Text>
                ),
              },
              {
                title: '状态 / 未恢复原因',
                render: (_, row) => (
                  <Tag color={REASON_TAG_COLOR[row.reason]}>
                    {row.recovered
                      ? '已恢复'
                      : RETEST_STRING_REASON_LABEL[row.reason]}
                  </Tag>
                ),
              },
            ]}
          />
        </Space>
      )}
    </Drawer>
  );
}
