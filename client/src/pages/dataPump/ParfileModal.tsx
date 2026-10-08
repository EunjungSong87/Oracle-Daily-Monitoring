import type { ReactElement } from 'react';
import { Modal } from '../../shared/components/Modal';
import { showToast } from '../../shared/lib/toastStore';
import { downloadText } from './helpers';

export interface ParfileView {
  title: string;
  command: string;
  parfile: string;
  parfileName: string;
  notes?: string[]; // 작업 설명·실행 전 TRUNCATE 문 등 — parfile에는 주석으로도 넣지 않는다 (서버에서 expdp가 에러)
}

interface Props {
  view: ParfileView | null;
  onClose: () => void;
  // 주면 "DB 서버 DIRECTORY에 저장" 버튼을 보여준다.
  serverDirectory?: string;
  onSaveToServer?: (view: ParfileView) => void;
  saving?: boolean;
}

// 앱에서 직접 실행하지 않고 DB 서버에서 expdp/impdp로 돌릴 때 쓸 parfile과 명령어.
export function ParfileModal({ view, onClose, serverDirectory, onSaveToServer, saving }: Props): ReactElement | null {
  if (!view) return null;

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      showToast('복사했습니다.');
    } catch {
      showToast('클립보드에 복사하지 못했습니다.', 'error');
    }
  }

  return (
    <Modal open onClose={onClose} title={view.title} wide>
      <div className="modal-body">
        <p className="dp-label">DB 서버에서 실행할 명령어 (비밀번호는 실행할 때 입력, parfile이 있는 디렉토리에서 실행)</p>
        <div className="dp-code-row">
          <pre className="rt-sql-text dp-command">{view.command}</pre>
          <button type="button" className="btn-secondary" onClick={() => copy(view.command)}>
            복사
          </button>
        </div>
        {view.notes && view.notes.length > 0 && (
          <>
            <p className="dp-label">참고 (parfile에는 들어가지 않음)</p>
            <pre className="rt-sql-text dp-command">{view.notes.join('\n')}</pre>
          </>
        )}
        <p className="dp-label">
          parfile — <code>{view.parfileName}</code>
        </p>
        <pre className="rt-sql-text">{view.parfile}</pre>
        <div className="oc-actions dp-buttons">
          <button type="button" className="btn-secondary" onClick={() => copy(view.parfile)}>
            parfile 복사
          </button>
          <button type="button" className="btn-secondary" onClick={() => downloadText(view.parfileName, view.parfile)}>
            내 PC로 다운로드
          </button>
          {onSaveToServer && serverDirectory && (
            <button type="button" disabled={saving} onClick={() => onSaveToServer(view)}>
              {saving ? '저장 중...' : `DB 서버 ${serverDirectory}에 저장`}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
