/**
 * 整箱复测发起弹窗
 * 选择逆变器 + 汇流箱后做发起预检：
 * - 同箱已有进行中批次 → 提示先结束上一批
 * - 历史不足最近 8 条的组串逐串列出，挡住发起
 * 预检通过后发起，发起点冻结每串基准。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { CheckCircleFilled, CloseCircleFilled, LockOutlined } from '@ant-design/icons';
import { useRetestStore } from '../../stores/retestStore';
import { useDeviceStore } from '../../stores/deviceStore';
import { useSampleStore } from '../../stores/sampleStore';
import type { RetestPrecheck } from '../../types/retest';
import { BASELINE_SAMPLE_COUNT, MIN_BATCH_SAMPLE_COUNT, RETEST_CLEAR_RATIO } from '../../types/retest';
import { formatCurrent } from '../../utils/unit';

interface RetestStartModalProps {
  open: boolean;
  onClose: () => void;
  /** 可选：预选逆变器 / 汇流箱（从汇流箱对比卡片发起时带入） */
  initialInverterId?: string;
  initialCombinerBox?: string;
  /** 发起成功后的回调（如跳转到进度抽屉） */
  onStarted?: (batchId: string) => void;
}

export default function RetestStartModal({
  open,
  onClose,
  initialInverterId = '',
  initialCombinerBox = '',
  onStarted,
}: RetestStartModalProps) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ inverterId: string; combinerBox: string; owner: string }>();
  const inverters = useDeviceStore((state) => state.inverters);
  const arrays = useDeviceStore((state) => state.arrays);
  const strings = useDeviceStore((state) => state.strings);
  const thresholds = useSampleStore((state) => state.thresholds);
  const precheck = useRetestStore((state) => state.precheck);
  const startBatch = useRetestStore((state) => state.startBatch);

  const [inverterId, setInverterId] = useState(initialInverterId);
  const [combinerBox, setCombinerBox] = useState(initialCombinerBox);
  const [result, setResult] = useState<RetestPrecheck | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setInverterId(initialInverterId);
      setCombinerBox(initialCombinerBox);
      setResult(null);
      form.setFieldsValue({
        inverterId: initialInverterId || undefined,
        combinerBox: initialCombinerBox || undefined,
        owner: '李文波',
      });
      if (initialInverterId && initialCombinerBox) {
        void precheck(initialInverterId, initialCombinerBox).then(setResult);
      }
    }
    // 仅在弹窗打开/预选变化时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialInverterId, initialCombinerBox]);

  const boxOptions = useMemo(() => {
    const scope = inverterId ? strings.filter((item) => item.inverterId === inverterId) : strings;
    return [...new Set(scope.map((item) => item.combinerBox))].sort();
  }, [strings, inverterId]);

  const codeOf = (stringId: string): string =>
    strings.find((item) => item.id === stringId)?.code ?? '已删除组串';

  const runCheck = async (nextInverter = inverterId, nextBox = combinerBox): Promise<void> => {
    if (!nextInverter || !nextBox) {
      setResult(null);
      return;
    }
    const check = await precheck(nextInverter, nextBox);
    setResult(check);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const row = await startBatch({
        inverterId: values.inverterId,
        combinerBox: values.combinerBox,
        owner: values.owner,
      });
      message.success(
        `已发起整箱复测：冻结 ${row.baselines.length} 串最近 ${BASELINE_SAMPLE_COUNT} 条归一化电流均值为基准`,
      );
      onStarted?.(row.id);
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发起失败');
      void runCheck(values.inverterId, values.combinerBox);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="发起整箱复测"
      width={680}
      open={open}
      onCancel={onClose}
      maskClosable={false}
      footer={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button
            type="primary"
            icon={<LockOutlined />}
            loading={submitting}
            disabled={!result?.canStart}
            onClick={() => void submit()}
          >
            冻结基准并发起
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        发起瞬间冻结箱内每串最近 {BASELINE_SAMPLE_COUNT} 条归一化电流的均值作为复测基准；发起后录入的新读数自动归入本批次，
        每串至少 {MIN_BATCH_SAMPLE_COUNT} 条、均值达到冻结基准 {Math.round(RETEST_CLEAR_RATIO * 100)}% 才算恢复。
        基准以发起冻结值为准，不受复测时箱内均值漂移与后续阈值修改影响。
      </Typography.Paragraph>

      <Form form={form} layout="vertical">
        <Space wrap align="start">
          <Form.Item
            name="inverterId"
            label="逆变器"
            style={{ minWidth: 240 }}
            rules={[{ required: true, message: '请选择逆变器' }]}
          >
            <Select
              placeholder="选择逆变器"
              options={inverters.map((item) => {
                const array = arrays.find((row) => row.id === item.arrayId);
                return { label: `${array?.code ?? '-'} / ${item.model}`, value: item.id };
              })}
              onChange={(value: string) => {
                setInverterId(value);
                setCombinerBox('');
                form.setFieldValue('combinerBox', undefined);
                void runCheck(value, '');
              }}
            />
          </Form.Item>
          <Form.Item
            name="combinerBox"
            label="汇流箱"
            style={{ minWidth: 160 }}
            rules={[{ required: true, message: '请选择汇流箱' }]}
          >
            <Select
              placeholder="选择汇流箱"
              options={boxOptions.map((code) => ({ label: code, value: code }))}
              onChange={(value: string) => {
                setCombinerBox(value);
                void runCheck(inverterId, value);
              }}
            />
          </Form.Item>
          <Form.Item
            name="owner"
            label="发起人"
            style={{ minWidth: 140 }}
            rules={[{ required: true, message: '请输入发起人' }]}
          >
            <Input placeholder="如：李文波" />
          </Form.Item>
        </Space>
      </Form>

      {result ? (
        result.canStart ? (
          <Alert
            type="success"
            showIcon
            icon={<CheckCircleFilled />}
            style={{ marginBottom: 12 }}
            message={`预检通过：箱内 ${result.totalCount} 串历史读数均满足最近 ${BASELINE_SAMPLE_COUNT} 条，可以发起`}
          />
        ) : (
          <Alert
            type="error"
            showIcon
            icon={<CloseCircleFilled />}
            style={{ marginBottom: 12 }}
            message="暂不能发起整箱复测"
            description={result.blockReason}
          />
        )
      ) : null}

      {result && result.totalCount > 0 ? (
        <Table
          size="small"
          pagination={false}
          rowKey="stringId"
          dataSource={[
            ...result.ready.map((item) => ({ ...item, insufficient: false })),
            ...result.insufficient.map((item) => ({
              ...item,
              baselineCurrentA: 0,
              insufficient: true,
            })),
          ]}
          columns={[
            {
              title: '组串',
              dataIndex: 'stringId',
              render: (value: string) => <span>{result.combinerBox} · {codeOf(value)}</span>,
            },
            {
              title: `历史读数条数（需 ≥ ${BASELINE_SAMPLE_COUNT}）`,
              dataIndex: 'sampleCount',
              width: 200,
              render: (value: number) => (
                <Tag color={value >= BASELINE_SAMPLE_COUNT ? 'success' : 'error'}>{value} 条</Tag>
              ),
            },
            {
              title: '冻结基准（归一化 A）',
              dataIndex: 'baselineCurrentA',
              width: 170,
              render: (value: number, row: { insufficient: boolean }) =>
                row.insufficient ? <span className="gb-hint">—</span> : formatCurrent(value),
            },
            {
              title: '预检',
              width: 110,
              render: (_, row: { insufficient: boolean }) =>
                row.insufficient ? <Tag color="error">不足，挡住发起</Tag> : <Tag color="success">就绪</Tag>,
            },
          ]}
        />
      ) : null}

      <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
        当前标准辐照度（发起冻结用）：{thresholds.standardIrradiance} W/m²。发起后即使在阈值页修改该值，
        本批次仍按发起时冻结的口径判定。
      </Typography.Paragraph>
    </Modal>
  );
}
