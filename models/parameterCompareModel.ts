import oracledb from 'oracledb';
import * as db from '../db';
import * as dbmsModel from './dbmsModel';
import type { DbmsIdParam } from './dbmsModel';

export interface ParameterInfo {
  name: string;
  value: string | null; // 비교용 원본 값 (예: 2147483648)
  displayValue: string | null; // 화면용 값 (예: 2G)
  isDefault: boolean;
  description: string | null;
}

export interface InstanceInfo {
  instanceName: string;
  hostName: string;
  version: string;
}

// 파라미터를 어디서 읽었는지. hidden(_) 파라미터 전체는 X$ 테이블에만 있고 X$는 SYS만 볼 수 있어서,
// SYS가 아니면 DBA가 만들어 grant한 SYS.X_$KSPPI/X_$KSPPCV 뷰를 쓰고, 그것도 없으면 V$PARAMETER로 내려갑니다.
export type ParameterSource = 'X$' | 'X_$_VIEW' | 'V$PARAMETER';

export interface ParameterSnapshot {
  dbname: string;
  instance: InstanceInfo | null;
  parameters: ParameterInfo[];
  source: ParameterSource;
  hiddenIncluded: boolean;
}

// 대상 DBMS에 접속합니다 (objectCompareModel과 동일한 방식). dbname도 함께 돌려줍니다.
async function connectTarget(dbmsid: DbmsIdParam): Promise<{ connection: oracledb.Connection; dbname: string }> {
  const dbconfig = await dbmsModel.getDbmsInfo(dbmsid);
  if (!dbconfig) {
    throw new Error('DBMS 정보를 찾을 수 없습니다.');
  }
  const config = {
    user: dbconfig[0],
    password: dbconfig[1],
    connectString: dbconfig[2] + ':' + dbconfig[3] + '/' + dbconfig[4],
  };
  return { connection: await db.connectDB(config), dbname: dbconfig[6] };
}

const HIDDEN_QUERY = (ksppi: string, ksppcv: string): string => `
  SELECT a.KSPPINM AS NAME, b.KSPPSTVL AS VALUE, b.KSPPSTDVL AS DISPLAY_VALUE,
         b.KSPPSTDF AS ISDEFAULT, a.KSPPDESC AS DESCRIPTION
    FROM ${ksppi} a
    JOIN ${ksppcv} b ON b.INDX = a.INDX AND b.INST_ID = a.INST_ID
   WHERE a.INST_ID = USERENV('INSTANCE')
   ORDER BY a.KSPPINM`;

// 위에서부터 차례로 시도합니다. 권한이 없는 경우(ORA-00942 등)만 다음으로 넘어가고, 다른 에러는 그대로 던집니다.
const PARAMETER_QUERIES: { source: ParameterSource; sql: string }[] = [
  { source: 'X$', sql: HIDDEN_QUERY('X$KSPPI', 'X$KSPPCV') },
  { source: 'X_$_VIEW', sql: HIDDEN_QUERY('SYS.X_$KSPPI', 'SYS.X_$KSPPCV') },
  { source: 'V$PARAMETER', sql: `SELECT NAME, VALUE, DISPLAY_VALUE, ISDEFAULT, DESCRIPTION FROM V$PARAMETER ORDER BY NAME` },
];

// ORA-00942: table or view does not exist / ORA-01031: insufficient privileges
function isNoAccess(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^ORA-(00942|01031)\b/.test(message);
}

// 접속한 인스턴스의 초기화 파라미터 전체(가능하면 hidden 포함)를 가져옵니다. RAC라면 접속된 인스턴스 기준입니다.
async function getParameters(dbmsid: DbmsIdParam): Promise<ParameterSnapshot> {
  let connection: oracledb.Connection | undefined;
  try {
    const target = await connectTarget(dbmsid);
    connection = target.connection;
    const options = { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchArraySize: 1000 };

    let parameterResult: oracledb.Result<Record<string, any>> | undefined;
    let source: ParameterSource = 'V$PARAMETER';
    for (const candidate of PARAMETER_QUERIES) {
      try {
        parameterResult = await connection.execute<Record<string, any>>(candidate.sql, {}, options);
        source = candidate.source;
        break;
      } catch (error) {
        if (candidate.source === 'V$PARAMETER' || !isNoAccess(error)) throw error;
      }
    }
    // 버전/호스트는 화면 머리글의 참고 정보일 뿐이라, V$INSTANCE 권한이 없어도 비교 자체는 되게 합니다.
    let instance: InstanceInfo | null = null;
    try {
      const instanceResult = await connection.execute<Record<string, any>>(
        `SELECT INSTANCE_NAME, HOST_NAME, VERSION FROM V$INSTANCE`,
        {},
        options
      );
      const row = instanceResult.rows?.[0];
      if (row) instance = { instanceName: row.INSTANCE_NAME, hostName: row.HOST_NAME, version: row.VERSION };
    } catch {
      instance = null;
    }

    return {
      dbname: target.dbname,
      instance,
      source,
      hiddenIncluded: source !== 'V$PARAMETER',
      parameters: (parameterResult?.rows ?? []).map((row) => ({
        name: row.NAME,
        value: row.VALUE,
        displayValue: row.DISPLAY_VALUE,
        isDefault: row.ISDEFAULT === 'TRUE',
        description: row.DESCRIPTION,
      })),
    };
  } finally {
    if (connection) await connection.close();
  }
}

export { getParameters };
