import * as parameterCompareModel from '../models/parameterCompareModel';
import type { InstanceInfo, ParameterInfo, ParameterSnapshot, ParameterSource } from '../models/parameterCompareModel';

export type ParameterResult = 'SAME' | 'DIFF' | 'ONLY_SOURCE' | 'ONLY_TARGET';

export interface ParameterSideValue {
  value: string | null;
  displayValue: string | null;
  isDefault: boolean;
}

export interface ParameterItem {
  name: string;
  result: ParameterResult;
  // DB 이름, 경로, 리스너처럼 DB마다 다른 게 정상인 파라미터 — 화면에서 기본으로 숨깁니다.
  envSpecific: boolean;
  hidden: boolean; // 이름이 _로 시작하는 hidden(언더스코어) 파라미터
  description: string | null;
  source: ParameterSideValue | null;
  target: ParameterSideValue | null;
}

export interface ParameterCompareSide {
  dbmsid: number | string;
  dbname: string;
  instance: InstanceInfo | null;
  source: ParameterSource;
  hiddenIncluded: boolean;
}

export interface ParameterCompareResponse {
  source: ParameterCompareSide;
  target: ParameterCompareSide;
  // 양쪽 모두 hidden 전체를 읽었을 때만 true. 한쪽만 읽었으면 직접 설정한(기본값 아닌) hidden만 비교합니다.
  hiddenFullyCompared: boolean;
  items: ParameterItem[];
}

// 환경(DB/서버)마다 당연히 달라야 하는 파라미터. 차이가 나도 설정 오류가 아니라서 따로 표시합니다.
const ENV_SPECIFIC = new Set([
  'db_name',
  'db_unique_name',
  'db_domain',
  'instance_name',
  'instance_number',
  'service_names',
  'control_files',
  'spfile',
  'local_listener',
  'remote_listener',
  'listener_networks',
  'audit_file_dest',
  'diagnostic_dest',
  'background_dump_dest',
  'user_dump_dest',
  'core_dump_dest',
  'db_create_file_dest',
  'db_recovery_file_dest',
  'log_archive_config',
  'fal_server',
  'fal_client',
  'db_file_name_convert',
  'log_file_name_convert',
  'pdb_file_name_convert',
  'thread',
  'cluster_interconnects',
  'dispatchers',
  'utl_file_dir',
]);
const ENV_SPECIFIC_PREFIXES = ['log_archive_dest', 'db_create_online_log_dest_', 'dg_broker_config_file'];

function isEnvSpecific(name: string): boolean {
  return ENV_SPECIFIC.has(name) || ENV_SPECIFIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

// 값 비교는 화면용 DISPLAY_VALUE(2G)가 아니라 VALUE(바이트 수)로 해서 "2G"와 "2048M"을 같게 봅니다.
// Oracle 파라미터 값은 대소문자를 구분하지 않으므로(TRUE/true, 날짜 포맷 등) 대소문자도 무시합니다.
function normalizeValue(value: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function toSide(parameter: ParameterInfo | undefined): ParameterSideValue | null {
  if (!parameter) return null;
  return { value: parameter.value, displayValue: parameter.displayValue, isDefault: parameter.isDefault };
}

function isHidden(name: string): boolean {
  return name.startsWith('_');
}

// 한쪽만 hidden 전체(X$)를 읽고 다른 쪽은 V$SYSTEM_PARAMETER(= 직접 설정한 hidden만 보임)라면, 그대로 비교하면
// 기본값 hidden 수천 개가 전부 "한쪽에만 있음"으로 나옵니다. 그래서 그 경우엔 X$를 읽은 쪽도
// 기본값인 hidden은 빼고, 양쪽 모두 "직접 설정한 hidden"끼리만 비교합니다.
function comparableParameters(snapshot: ParameterSnapshot, other: ParameterSnapshot): ParameterInfo[] {
  if (!snapshot.hiddenIncluded || other.hiddenIncluded) return snapshot.parameters;
  return snapshot.parameters.filter((parameter) => !isHidden(parameter.name) || !parameter.isDefault);
}

// DB 접근이 없는 순수 함수 — 이름 순으로 정렬된 비교 결과를 만듭니다.
function compareParameterSnapshots(source: ParameterSnapshot, target: ParameterSnapshot): ParameterItem[] {
  const sourceByName = new Map(comparableParameters(source, target).map((parameter) => [parameter.name, parameter]));
  const targetByName = new Map(comparableParameters(target, source).map((parameter) => [parameter.name, parameter]));
  const names = Array.from(new Set([...sourceByName.keys(), ...targetByName.keys()])).sort();

  return names.map((name) => {
    const left = sourceByName.get(name);
    const right = targetByName.get(name);
    let result: ParameterResult;
    if (!left) result = 'ONLY_TARGET';
    else if (!right) result = 'ONLY_SOURCE';
    else result = normalizeValue(left.value) === normalizeValue(right.value) ? 'SAME' : 'DIFF';
    return {
      name,
      result,
      envSpecific: isEnvSpecific(name),
      hidden: isHidden(name),
      description: left?.description ?? right?.description ?? null,
      source: toSide(left),
      target: toSide(right),
    };
  });
}

async function compareParameters(sourceDbmsId: number | string, targetDbmsId: number | string): Promise<ParameterCompareResponse> {
  let sourceSnapshot: ParameterSnapshot;
  let targetSnapshot: ParameterSnapshot;
  try {
    [sourceSnapshot, targetSnapshot] = await Promise.all([
      parameterCompareModel.getParameters({ dbmsid: sourceDbmsId }),
      parameterCompareModel.getParameters({ dbmsid: targetDbmsId }),
    ]);
  } catch (error) {
    throw new Error('파라미터 조회 실패', { cause: error });
  }
  const side = (dbmsid: number | string, snapshot: ParameterSnapshot): ParameterCompareSide => ({
    dbmsid,
    dbname: snapshot.dbname,
    instance: snapshot.instance,
    source: snapshot.source,
    hiddenIncluded: snapshot.hiddenIncluded,
  });
  return {
    source: side(sourceDbmsId, sourceSnapshot),
    target: side(targetDbmsId, targetSnapshot),
    hiddenFullyCompared: sourceSnapshot.hiddenIncluded && targetSnapshot.hiddenIncluded,
    items: compareParameterSnapshots(sourceSnapshot, targetSnapshot),
  };
}

export { compareParameters, compareParameterSnapshots, isEnvSpecific };
