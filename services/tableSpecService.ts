import ExcelJS from 'exceljs';
import * as tableSpecModel from '../models/tableSpecModel';
import type { TableSpec } from '../models/tableSpecModel';
import type { DbmsIdParam } from '../models/dbmsModel';

async function getSchemas(dbmsid: DbmsIdParam): Promise<string[]> {
  try {
    return await tableSpecModel.getSchemas(dbmsid);
  } catch (error) {
    console.error('Service : 스키마 목록 조회 실패:', error);
    throw new Error('스키마 목록 조회 실패', { cause: error });
  }
}

async function getTables(dbmsid: DbmsIdParam, owner: string): Promise<string[]> {
  try {
    return await tableSpecModel.getTables(dbmsid, owner);
  } catch (error) {
    console.error('Service : 테이블 목록 조회 실패:', error);
    throw new Error('테이블 목록 조회 실패', { cause: error });
  }
}

const DEFAULT_TABLES_PER_SHEET = 20;
// 엑셀 시트 한 장의 실제 한도(1,048,576행)에 걸리지 않도록 두는 안전장치.
// 사용자가 시트당 테이블 수를 아무리 크게 잡아도 이 행 수를 넘기면 강제로 다음 시트로 넘어갑니다.
const MAX_ROWS_PER_SHEET = 660000;
const TITLE_FILL = 'FF1F2937';
const SECTION_FILL = 'FFE5E7EB';
const CONSTRAINT_TYPE_LABEL: Record<string, string> = { P: 'PRIMARY KEY', R: 'FOREIGN KEY', U: 'UNIQUE', C: 'CHECK' };

function sanitizeSheetName(name: string): string {
  return String(name).replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
}

// 스키마(owner) 하나에 대해 테이블들을 세로로 계속 이어붙이고,
// 시트당 테이블 수가 tablesPerSheet를 넘거나 행 수가 안전 한도를 넘으면
// 자동으로 새 시트(OWNER_2, OWNER_3 ...)를 엽니다.
class SchemaSheetWriter {
  workbook: ExcelJS.Workbook;
  owner: string;
  tablesPerSheet: number;
  part: number;
  tableCount: number;
  rowCount: number;
  sheet!: ExcelJS.Worksheet;

  constructor(workbook: ExcelJS.Workbook, owner: string, tablesPerSheet: number) {
    this.workbook = workbook;
    this.owner = owner;
    this.tablesPerSheet = tablesPerSheet;
    this.part = 1;
    this.tableCount = 0;
    this.rowCount = 0;
    this._newSheet();
  }

  _newSheet(): void {
    const name = this.part === 1 ? this.owner : `${this.owner}_${this.part}`;
    this.sheet = this.workbook.addWorksheet(sanitizeSheetName(name));
    this.sheet.columns = [
      { width: 26 }, { width: 20 }, { width: 14 }, { width: 12 },
      { width: 12 }, { width: 12 }, { width: 32 }, { width: 32 },
    ];
    this.tableCount = 0;
    this.rowCount = 0;
    this.part += 1;
  }

  startTableBlock(): void {
    if (this.tableCount >= this.tablesPerSheet || this.rowCount >= MAX_ROWS_PER_SHEET) {
      this._newSheet();
    }
    this.tableCount += 1;
  }

  addRow(values: unknown[]): ExcelJS.Row {
    this.rowCount += 1;
    return this.sheet.addRow(values);
  }

  blankRow(): void {
    this.addRow([]);
  }
}

function writeSection(
  writer: SchemaSheetWriter,
  titleKo: string,
  titleEn: string,
  subHeaders: string[],
  dataRows: unknown[][]
): void {
  const sectionRow = writer.addRow([`${titleKo}(${titleEn})`]);
  sectionRow.font = { bold: true };
  sectionRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SECTION_FILL } };

  const headerRow = writer.addRow(subHeaders);
  headerRow.font = { bold: true };

  if (dataRows.length === 0) {
    writer.addRow(['(없음)']);
  } else {
    dataRows.forEach((row) => writer.addRow(row));
  }
  writer.blankRow();
}

function writeTableBlock(
  writer: SchemaSheetWriter,
  table: Record<string, any>,
  columns: Record<string, any>[],
  constraints: Record<string, any>[],
  indexes: Record<string, any>[],
  grants: Record<string, any>[],
  synonyms: Record<string, any>[]
): void {
  writer.startTableBlock();

  const titleRow = writer.addRow([`TABLE : ${table.TABLE_NAME}`]);
  titleRow.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titleRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TITLE_FILL } };

  writer.addRow([`코멘트: ${table.COMMENTS || ''}`]);
  writer.blankRow();

  writeSection(
    writer, '컬럼', 'Columns',
    ['컬럼명', '데이터타입', '길이', 'PRECISION', 'SCALE', 'NULL허용', '기본값', '코멘트'],
    columns.map((c) => [
      c.COLUMN_NAME,
      c.DATA_TYPE,
      c.DATA_LENGTH,
      c.DATA_PRECISION,
      c.DATA_SCALE,
      c.NULLABLE === 'N' ? 'NOT NULL' : 'NULL',
      c.DATA_DEFAULT ? String(c.DATA_DEFAULT).trim() : '',
      c.COMMENTS || '',
    ])
  );

  writeSection(
    writer, '제약조건', 'Constraints',
    ['제약조건명', '유형', '대상컬럼', '참조테이블/조건'],
    constraints.map((c) => [
      c.CONSTRAINT_NAME,
      CONSTRAINT_TYPE_LABEL[c.CONSTRAINT_TYPE] || c.CONSTRAINT_TYPE,
      c.COLUMNS,
      c.CONSTRAINT_TYPE === 'R'
        ? `REF: ${c.R_TABLE_NAME || ''}(${c.R_CONSTRAINT_NAME || ''})`
        : (c.SEARCH_CONDITION || ''),
    ])
  );

  writeSection(
    writer, '인덱스', 'Indexes',
    ['인덱스명', 'UNIQUE여부', '타입', '대상컬럼'],
    indexes.map((i) => [i.INDEX_NAME, i.UNIQUENESS, i.INDEX_TYPE, i.COLUMNS])
  );

  writeSection(
    writer, '권한', 'Grants',
    ['GRANTEE', 'PRIVILEGE', 'GRANTABLE'],
    grants.map((g) => [g.GRANTEE, g.PRIVILEGE, g.GRANTABLE])
  );

  writeSection(
    writer, '시노님', 'Synonyms',
    ['시노님 소유자', '시노님명'],
    synonyms.map((s) => [s.SYNONYM_OWNER, s.SYNONYM_NAME])
  );

  writer.blankRow();
}

function groupByTable(rows: Record<string, any>[]): Record<string, Record<string, any>[]> {
  const map: Record<string, Record<string, any>[]> = {};
  rows.forEach((row) => {
    if (!map[row.TABLE_NAME]) map[row.TABLE_NAME] = [];
    map[row.TABLE_NAME].push(row);
  });
  return map;
}

function buildWorkbook(owner: string, spec: TableSpec, tablesPerSheet: number): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Oracle Daily Monitoring';
  workbook.created = new Date();

  const columnsByTable = groupByTable(spec.columns);
  const constraintsByTable = groupByTable(spec.constraints);
  const indexesByTable = groupByTable(spec.indexes);
  const grantsByTable = groupByTable(spec.grants);
  const synonymsByTable = groupByTable(spec.synonyms);

  const writer = new SchemaSheetWriter(workbook, owner, tablesPerSheet);

  spec.tables.forEach((table) => {
    writeTableBlock(
      writer,
      table,
      columnsByTable[table.TABLE_NAME] || [],
      constraintsByTable[table.TABLE_NAME] || [],
      indexesByTable[table.TABLE_NAME] || [],
      grantsByTable[table.TABLE_NAME] || [],
      synonymsByTable[table.TABLE_NAME] || []
    );
  });

  return workbook;
}

async function buildTableSpecWorkbook(
  dbmsid: DbmsIdParam,
  owner: string,
  tables: string[] | 'ALL',
  tablesPerSheet?: number | string
): Promise<ExcelJS.Workbook> {
  try {
    const tableNames = tables === 'ALL' ? await tableSpecModel.getTables(dbmsid, owner) : tables;
    if (!tableNames || tableNames.length === 0) {
      throw new Error('선택된 테이블이 없습니다.');
    }
    const perSheet = Number(tablesPerSheet) > 0 ? Number(tablesPerSheet) : DEFAULT_TABLES_PER_SHEET;
    const spec = await tableSpecModel.getTableSpec(dbmsid, owner, tableNames);
    return buildWorkbook(owner, spec, perSheet);
  } catch (error) {
    console.error('Service : 테이블 명세서 생성 실패:', error);
    throw new Error('테이블 명세서 생성 실패', { cause: error });
  }
}

export { getSchemas, getTables, buildTableSpecWorkbook, sanitizeSheetName };
