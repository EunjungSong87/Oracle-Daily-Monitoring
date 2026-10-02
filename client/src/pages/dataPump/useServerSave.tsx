import { useState, type ReactElement } from 'react';
import { saveDataPumpFiles } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import { ConfirmModal } from './ConfirmModal';

interface PendingOverwrite {
  directory: string;
  files: { name: string; content: string }[];
  existing: string[];
}

// parfile을 DB 서버 DIRECTORY에 저장하는 흐름: 먼저 덮어쓰지 않고 저장해 보고, 이미 있는 파일이 있으면
// 목록을 보여주고 확인받은 뒤 그 파일들만 덮어쓴다. confirmNode는 화면 어딘가에 같이 렌더링해야 한다.
export function useServerSave(dbmsId: string): {
  save: (directory: string, files: { name: string; content: string }[]) => Promise<void>;
  saving: boolean;
  confirmNode: ReactElement;
} {
  const [saving, setSaving] = useState(false);
  const [pending, setPending] = useState<PendingOverwrite | null>(null);

  async function save(directory: string, files: { name: string; content: string }[]): Promise<void> {
    setSaving(true);
    try {
      const { written, skipped } = await saveDataPumpFiles(dbmsId, directory, files, false);
      if (written.length > 0) showToast(`${directory}에 ${written.length}개 파일을 저장했습니다.`);
      if (skipped.length > 0) setPending({ directory, files: files.filter((file) => skipped.includes(file.name)), existing: skipped });
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'DB 서버에 저장하지 못했습니다.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function overwrite(): Promise<void> {
    if (!pending) return;
    setSaving(true);
    try {
      const { written } = await saveDataPumpFiles(dbmsId, pending.directory, pending.files, true);
      showToast(`${pending.directory}에 ${written.length}개 파일을 덮어썼습니다.`);
      setPending(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : '덮어쓰지 못했습니다.', 'error');
    } finally {
      setSaving(false);
    }
  }

  const confirmNode = (
    <ConfirmModal
      open={!!pending}
      title="이미 있는 파일"
      confirmLabel={`${pending?.existing.length ?? 0}개 덮어쓰기`}
      danger
      busy={saving}
      onConfirm={overwrite}
      onClose={() => setPending(null)}
    >
      <p>
        DB 서버 <strong>{pending?.directory}</strong>에 같은 이름의 파일이 이미 있습니다 (나머지 파일은 저장했습니다).
      </p>
      <div className="dp-table-chips">
        {pending?.existing.map((name) => (
          <span key={name} className="dp-chip">
            {name}
          </span>
        ))}
      </div>
    </ConfirmModal>
  );

  return { save, saving, confirmNode };
}
