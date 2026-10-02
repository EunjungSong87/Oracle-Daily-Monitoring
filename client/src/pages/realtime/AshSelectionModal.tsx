import type { ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import type { AshExecution, AshTimeRange } from '../../shared/lib/types';
import { formatElapsed } from './ElapsedScatter';

export interface DetailTarget {
  sid: number;
  serial: number | null;
  sqlId: string | null;
  range: AshTimeRange | null; // null이면 서버가 최근 10분을 봄
}

interface Props {
  executions: AshExecution[] | null; // 드래그로 고른 점(= 끝난 SQL 실행)들
  hidden: boolean; // 상세 창이 위에 떠 있는 동안 잠깐 숨김 (닫으면 다시 보임)
  onClose: () => void;
  onOpenDetail: (execution: AshExecution) => void;
}

// 산점도에서 드래그로 고른 SQL 실행 목록. 행을 누르면 그 실행의 세션/ASH/SQL 상세 창을 연다.
export function AshSelectionModal({ executions, hidden, onClose, onOpenDetail }: Props): ReactElement | null {
  if (!executions || hidden) return null;

  const sorted = [...executions].sort((a, b) => (b.maxElapsedSec ?? 0) - (a.maxElapsedSec ?? 0));
  const from = executions.map((execution) => execution.sqlExecStart ?? execution.firstSample).sort()[0];
  const to = executions.map((execution) => execution.lastSample).sort().slice(-1)[0];
  const sqlCount = new Set(executions.map((execution) => execution.sqlId)).size;

  return (
    <Modal open onClose={onClose} title="선택한 SQL 실행 (ASH)" wide="xl">
      <div className="modal-body">
        <p className="rt-modal-meta">
          실행 {executions.length}건 · SQL {sqlCount}개 · {from} ~ {to.slice(11)} (DB 시각) · 오래 걸린 순
        </p>
        <table className="table oc-items-table rt-ash-table">
          <thead>
            <tr>
              <th>걸린 시간</th>
              <th>SQL_ID</th>
              <th>시작 ~ 끝</th>
              <th>SID,SERIAL#</th>
              <th>USER</th>
              <th>주요 이벤트</th>
              <th>ASH 샘플</th>
              <th>PROGRAM / MODULE</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((execution, index) => (
              <tr key={index} className="oc-item-row" onClick={() => onOpenDetail(execution)}>
                <td>{execution.maxElapsedSec === null ? '' : formatElapsed(execution.maxElapsedSec)}</td>
                <td className="oc-name">{execution.sqlId ?? <span className="oc-none">(SQL 없음)</span>}</td>
                <td>
                  {execution.sqlExecStart?.slice(11) ?? ''} ~ {execution.lastSample.slice(11)}
                </td>
                <td className="oc-name">
                  {execution.sid},{execution.serial}
                </td>
                <td>{execution.username ?? ''}</td>
                <td>{execution.topEvent}</td>
                <td>{execution.samples}</td>
                <td>{[execution.program, execution.module].filter(Boolean).join(' / ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="oc-hint">행을 누르면 그 실행의 세션 정보, ASH 요약, SQL 전문/통계(V$SQL, 없으면 AWR)를 봅니다.</p>
      </div>
    </Modal>
  );
}
