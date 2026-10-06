/**
 * 整箱复测批次徽标：展示整箱恢复进度（已恢复 / 总数）。
 * 被失配排查工作台、处置单页消费。
 */
import { Tag, Tooltip, Typography } from 'antd';
import { CheckCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import type { RetestBatch } from '../../types/retest';

interface Props {
  batch: Pick<RetestBatch, 'state' | 'strings'>;
}

export default function RetestBatchTag({ batch }: Props) {
  const total = batch.strings.length;
  const recovered = batch.strings.filter((item) => item.recovered === true).length;
  const all = total > 0 && recovered === total;
  const color = batch.state === 'finished' ? 'success' : all ? 'success' : 'processing';
  const icon = batch.state === 'finished' || all ? <CheckCircleOutlined /> : <ReloadOutlined />;
  const unrecovered = batch.strings.filter((item) => item.recovered !== true);

  const tag = (
    <Tag color={color} icon={icon} style={{ marginInlineEnd: 0 }}>
      整箱复测 {recovered}/{total}
      {batch.state === 'finished' ? ' · 已结束' : all ? ' · 可结束' : ''}
    </Tag>
  );

  if (unrecovered.length === 0) return tag;

  return (
    <Tooltip
      title={
        <div>
          <div>未恢复 / 待复测 {unrecovered.length} 串：</div>
          {unrecovered.slice(0, 6).map((item) => (
            <div key={item.stringId}>
              <Typography.Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12 }}>
                {item.reason || '待复测'}
              </Typography.Text>
            </div>
          ))}
          {unrecovered.length > 6 ? <div>…共 {unrecovered.length} 串</div> : null}
        </div>
      }
    >
      {tag}
    </Tooltip>
  );
}
