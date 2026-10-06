import type { ReactElement } from 'react';
import type { PartitionImportJobView } from '../../shared/lib/types';
import { formatBytes } from './helpers';

interface Props {
  jobs: PartitionImportJobView[];
  started: Map<number, string>; // 작업 번호 → 시작한 작업 이름
  startingNo: number | 'ALL' | null;
  disabledReason?: (job: PartitionImportJobView) => string | null; // 지금 실행하면 안 되는 이유 (있으면 실행 버튼 비활성)
  onRun: (job: PartitionImportJobView) => void;
  onParfile: (job: PartitionImportJobView) => void;
}

// 덤프 하나 = import 작업 하나. 작업마다 parfile 보기 / 바로 실행.
export function PartitionJobList({ jobs, started, startingNo, disabledReason, onRun, onParfile }: Props): ReactElement {
  return (
    <table className="table oc-items-table">
      <thead>
        <tr>
          <th>#</th>
          <th>덤프 파일</th>
          <th>파티션</th>
          <th>크기</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => {
          const jobName = started.get(job.no);
          const reason = disabledReason?.(job) ?? null;
          return (
            <tr key={job.no}>
              <td>{job.no}</td>
              <td>
                <div className="oc-name">{job.dumpfile}</div>
                <div className="dp-hint-line">{job.request.logfile}</div>
              </td>
              <td>
                <div className="oc-name">{job.partitions.map((partition) => partition.name).join(', ')}</div>
                {job.extraPartitions.length > 0 && <div className="dp-hint-line">같은 덤프라 같이 들어감: {job.extraPartitions.join(', ')}</div>}
                {job.truncatePartitions.length > 0 && <div className="dp-hint-line">먼저 비움: {job.truncatePartitions.join(', ')}</div>}
              </td>
              <td>{formatBytes(job.bytes)}</td>
              <td className="dp-actions">
                <button type="button" className="btn-secondary" onClick={() => onParfile(job)}>
                  parfile
                </button>
                {jobName ? (
                  <span className="issue-badge oc-badge-SAME" title={jobName}>
                    시작함
                  </span>
                ) : (
                  <button type="button" disabled={startingNo !== null || reason !== null} title={reason ?? undefined} onClick={() => onRun(job)}>
                    실행
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
