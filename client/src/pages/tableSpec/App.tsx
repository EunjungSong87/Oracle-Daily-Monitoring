import { useEffect, useState, type ReactElement } from 'react';
import { AppHeader } from '../../shared/components/AppHeader';
import { ToastHost } from '../../shared/components/ToastHost';
import { canSee, useCurrentUser } from '../../shared/hooks/useCurrentUser';
import { downloadTableSpec, getDbmsList, getSchemas, getTables } from '../../shared/lib/api';
import { showToast } from '../../shared/lib/toastStore';
import type { DbmsRow, TableSpecSchemas } from '../../shared/lib/types';
import { SchemaTableGroup } from './SchemaTableGroup';

type Scope = 'ALL' | 'SELECT';

interface TableGroup {
  tables: string[] | 'loading' | 'error';
  checked: Set<string>;
}

// public/tableSpec.html 포팅.
export function App(): ReactElement {
  const { user, loading: userLoading } = useCurrentUser();
  const canUse = canSee(user, 'tableSpec');

  const [dbmsRows, setDbmsRows] = useState<DbmsRow[]>([]);
  const [dbmsId, setDbmsId] = useState('');
  const [schemas, setSchemas] = useState<string[] | 'loading' | null>(null);
  const [checkedSchemas, setCheckedSchemas] = useState<Set<string>>(new Set());
  const [scope, setScope] = useState<Scope>('ALL');
  const [tableGroups, setTableGroups] = useState<Record<string, TableGroup>>({});
  const [tablesPerSheet, setTablesPerSheet] = useState(20);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!canUse) return;
    getDbmsList()
      .then(({ rows }) => {
        setDbmsRows(rows);
        if (rows.length > 0) setDbmsId(String(rows[0].ID));
      })
      .catch((error) => {
        console.error('Error loading dbms list:', error);
        showToast('DBMS 목록 조회 실패', 'error');
      });
  }, [canUse]);

  // DBMS가 바뀌면 스키마/테이블 선택 상태를 전부 초기화하고 다시 불러온다.
  useEffect(() => {
    if (!dbmsId) return;
    setTableGroups({});
    setSchemas('loading');
    getSchemas(dbmsId)
      .then((owners) => {
        setSchemas(owners);
        setCheckedSchemas(new Set(owners.length > 0 ? [owners[0]] : []));
      })
      .catch((error) => {
        console.error('Error loading schemas:', error);
        showToast('스키마 목록 조회 실패', 'error');
        setSchemas([]);
      });
  }, [dbmsId]);

  // 범위가 "개별 테이블 선택"이고 체크된 스키마가 바뀌면, 그룹을 맞춰 채운다
  // (체크 해제된 스키마의 그룹은 지우고, 새로 체크된 스키마만 fetch — 이미 있는 건 그대로 둔다).
  useEffect(() => {
    if (scope !== 'SELECT') return;
    setTableGroups((prev) => {
      const next: Record<string, TableGroup> = {};
      checkedSchemas.forEach((owner) => {
        if (prev[owner]) next[owner] = prev[owner];
      });
      return next;
    });
    checkedSchemas.forEach((owner) => {
      setTableGroups((prev) => {
        if (prev[owner]) return prev;
        getTables(dbmsId, owner)
          .then((tables) => setTableGroups((cur) => ({ ...cur, [owner]: { tables, checked: new Set() } })))
          .catch((error) => {
            console.error('Error loading tables:', error);
            setTableGroups((cur) => ({ ...cur, [owner]: { tables: 'error', checked: new Set() } }));
          });
        return { ...prev, [owner]: { tables: 'loading', checked: new Set() } };
      });
    });
  }, [scope, checkedSchemas, dbmsId]);

  function toggleSchema(owner: string): void {
    setCheckedSchemas((current) => {
      const next = new Set(current);
      if (next.has(owner)) next.delete(owner);
      else next.add(owner);
      return next;
    });
  }

  function toggleAllSchemas(checked: boolean): void {
    setCheckedSchemas(checked && Array.isArray(schemas) ? new Set(schemas) : new Set());
  }

  function toggleTable(owner: string, table: string): void {
    setTableGroups((prev) => {
      const group = prev[owner];
      if (!group || !Array.isArray(group.tables)) return prev;
      const nextChecked = new Set(group.checked);
      if (nextChecked.has(table)) nextChecked.delete(table);
      else nextChecked.add(table);
      return { ...prev, [owner]: { ...group, checked: nextChecked } };
    });
  }

  function toggleAllTables(owner: string, checked: boolean): void {
    setTableGroups((prev) => {
      const group = prev[owner];
      if (!group || !Array.isArray(group.tables)) return prev;
      return { ...prev, [owner]: { ...group, checked: checked ? new Set(group.tables) : new Set() } };
    });
  }

  async function handleDownload(): Promise<void> {
    if (!dbmsId) {
      showToast('DBMS를 선택해주세요.', 'error');
      return;
    }
    if (checkedSchemas.size === 0) {
      showToast('스키마를 하나 이상 선택해주세요.', 'error');
      return;
    }

    const schemaPayload: TableSpecSchemas = {};
    if (scope === 'ALL') {
      checkedSchemas.forEach((owner) => {
        schemaPayload[owner] = 'ALL';
      });
    } else {
      for (const owner of checkedSchemas) {
        const tables = Array.from(tableGroups[owner]?.checked ?? []);
        if (tables.length === 0) {
          showToast(`"${owner}" 스키마에서 테이블을 하나 이상 선택해주세요.`, 'error');
          return;
        }
        schemaPayload[owner] = tables;
      }
    }

    setDownloading(true);
    showToast('엑셀 생성 중...');
    try {
      const { blob, filename } = await downloadTableSpec(dbmsId, schemaPayload, tablesPerSheet || 20);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('엑셀 다운로드 완료.');
    } catch (error) {
      console.error('Error:', error);
      showToast(error instanceof Error ? error.message : '다운로드 중 오류가 발생했습니다.', 'error');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <AppHeader active="tableSpec" />
      <ToastHost />

      <h2 className="page-title">Table Spec (테이블 명세서)</h2>

      {!userLoading && !canUse && <p className="issues-empty">이 화면을 사용할 권한이 없습니다. 최고관리자에게 화면 권한을 요청하세요.</p>}

      {canUse && (
        <form onSubmit={(e) => e.preventDefault()}>
          <label htmlFor="DBMS_ID">DBMS:</label>
          <select id="DBMS_ID" required value={dbmsId} onChange={(e) => setDbmsId(e.target.value)}>
            {dbmsRows.map((row) => (
              <option key={String(row.ID)} value={String(row.ID)}>
                {String(row.ID)} - {row.DBNAME}
              </option>
            ))}
          </select>

          <label>스키마 (SCHEMA) — 여러 개 선택 가능:</label>
          <div style={{ marginBottom: 16 }}>
            <div style={{ marginBottom: 10 }}>
              <button type="button" className="btn-secondary" onClick={() => toggleAllSchemas(true)}>
                전체 선택
              </button>
              <button type="button" className="btn-secondary" onClick={() => toggleAllSchemas(false)}>
                전체 해제
              </button>
            </div>
            <div className="checkbox-panel">
              {schemas === 'loading' && '불러오는 중...'}
              {schemas === null && 'DBMS를 먼저 선택하세요'}
              {Array.isArray(schemas) && schemas.length === 0 && '스키마가 없습니다.'}
              {Array.isArray(schemas) &&
                schemas.map((owner) => (
                  <label key={owner} className="checkbox-row">
                    <input
                      type="checkbox"
                      style={{ marginRight: 8 }}
                      checked={checkedSchemas.has(owner)}
                      onChange={() => toggleSchema(owner)}
                    />
                    {owner}
                  </label>
                ))}
            </div>
          </div>

          <label>추출 범위:</label>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'inline-block', textTransform: 'none', fontWeight: 'normal', marginRight: 20 }}>
              <input
                type="radio"
                name="SCOPE"
                checked={scope === 'ALL'}
                onChange={() => setScope('ALL')}
              />{' '}
              스키마 전체
            </label>
            <label style={{ display: 'inline-block', textTransform: 'none', fontWeight: 'normal' }}>
              <input
                type="radio"
                name="SCOPE"
                checked={scope === 'SELECT'}
                onChange={() => setScope('SELECT')}
              />{' '}
              개별 테이블 선택
            </label>
          </div>

          {scope === 'SELECT' && (
            <div>
              <label>테이블 선택 (스키마별로):</label>
              <div>
                {checkedSchemas.size === 0 && <p className="issues-empty">먼저 위에서 스키마를 선택하세요.</p>}
                {Array.from(checkedSchemas).map((owner) => (
                  <SchemaTableGroup
                    key={owner}
                    owner={owner}
                    tables={tableGroups[owner]?.tables ?? 'loading'}
                    checked={tableGroups[owner]?.checked ?? new Set()}
                    onToggleTable={toggleTable}
                    onToggleAll={toggleAllTables}
                  />
                ))}
              </div>
            </div>
          )}

          <label htmlFor="TABLES_PER_SHEET">시트당 테이블 수:</label>
          <input
            type="number"
            id="TABLES_PER_SHEET"
            min={1}
            style={{ maxWidth: 120 }}
            value={tablesPerSheet}
            onChange={(e) => setTablesPerSheet(Number(e.target.value))}
          />

          <div style={{ marginTop: 16 }}>
            <button type="button" id="download-button" disabled={downloading} onClick={handleDownload}>
              엑셀 다운로드
            </button>
          </div>
        </form>
      )}
    </>
  );
}
