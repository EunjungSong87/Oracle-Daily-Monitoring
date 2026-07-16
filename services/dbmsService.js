const dbmsList = require('../models/dbmsModel'); // 데이터 모델 가져오기
const queries = require('../queries/index');  // index.js가 자동으로 로드됨
//const { readClobAsString } = require('./clobUtils');

// 사용자 목록 가져오기
async function getAllDbmses() {
  try {
    console.log('getAllDbmses Services ');
    const dbmses = await dbmsList.getAllDbmses();
    //console.log(dbmses);
    return dbmses;
  } catch (error) {
    console.error('Service : 사용자 목록 조회 실패:', error);
    throw new Error('사용자 목록 조회 실패', { cause: error });
  }
}

// <-- 모니터링 스크립트 정보 가져오기 
async function getScripts() {
  try {
    console.log('getScripts Service!! ');
    const scripts = await dbmsList.getScripts();
    //console.log(dbmses);
    return scripts;
  } catch (error) {
    console.error('Service : 스크립트 목록 조회 실패:', error);
    throw new Error('스크립트 목록 조회 실패', { cause: error });
  }
}


async function getDbmsInfo(dbmsid) {
  try {
    const  dbconfig = await dbmsList.getDbmsInfo(dbmsid);
    return dbconfig;
  } catch (error) {
    console.error('Service : DBMS 정보 가져오기 실패:', error);
    throw new Error('DBMS 정보 가져오기 실패', { cause: error });
  }
}

async function getSqlText(scriptid) {
  try {
    const  sql = await dbmsList.getSqlText(scriptid);
    console.log('Get SQL TEXT', sql );
    return sql;
  } catch (error) {
    console.error('Service : script 정보 가져오기 실패:', error);
    throw new Error('script 정보 가져오기 실패', { cause: error });
  }
}

async function listTasks() {
  try {
    console.log('system.listTasks 서비스 함수');
    const  results = await dbmsList.listTasks();
    return results;
  } catch (error) {
    console.error('Service : Tasks 가져오기 실패:', error);
    throw new Error('Tasks 가져오기 실패', { cause: error });
  }
}


// 값 하나가 임계치 규칙을 위반하는지 판단합니다.
function evaluateThreshold(rawValue, conditionType, operator, thresholdValue) {
  if (rawValue === null || rawValue === undefined) return false;

  if (conditionType === 'NUMERIC') {
    const value = parseFloat(String(rawValue).replace(/[^0-9.\-]/g, ''));
    const limit = parseFloat(thresholdValue);
    if (Number.isNaN(value) || Number.isNaN(limit)) return false;
    switch (operator) {
      case '>': return value > limit;
      case '>=': return value >= limit;
      case '<': return value < limit;
      case '<=': return value <= limit;
      case '=': return value === limit;
      case '!=': return value !== limit;
      default: return false;
    }
  }

  const strValue = String(rawValue);
  const strLimit = String(thresholdValue);

  if (conditionType === 'STRING') {
    if (operator === '=') return strValue === strLimit;
    if (operator === '!=') return strValue !== strLimit;
    return false;
  }

  if (conditionType === 'PATTERN') {
    return strValue.includes(strLimit);
  }

  return false;
}

// task에 걸린 임계치 규칙들을 각 row에 적용해 위반한 컬럼에 _alerts를 붙입니다.
function applyThresholds(rows, thresholdsForTask) {
  if (!thresholdsForTask || thresholdsForTask.length === 0) return rows;

  return rows.map((row) => {
    const alerts = {};
    for (const th of thresholdsForTask) {
      const column = th.COLUMN_NAME;
      if (evaluateThreshold(row[column], th.CONDITION_TYPE, th.OPERATOR, th.THRESHOLD)) {
        alerts[column] = { level: th.CLEVEL, message: th.MESSAGE };
      }
    }
    return Object.keys(alerts).length > 0 ? { ...row, _alerts: alerts } : row;
  });
}

async function getMonResult(dbmsid) {
  const results = [];
  let dbconfig;
  let tasks;
  let thresholds;
  try {
    dbconfig = await getDbmsInfo(dbmsid);
    tasks = await listTasks();
    thresholds = await dbmsList.getActiveThresholds();
  } catch (error) {
    console.error('Service : Monitoring Result 가져오기 실패:', error);
    throw new Error('Monitoring Result 가져오기 실패', { cause: error });
  }

  const thresholdsByTask = {};
  for (const th of thresholds) {
    const key = th.TASK_ID;
    if (!thresholdsByTask[key]) thresholdsByTask[key] = [];
    thresholdsByTask[key].push(th);
  }

  for ( const row of tasks.rows ) {
    const id = row[0];
    const checkName = row[1];
    const sql = row[2];

    // ogg_discard_log 체크는 VAN 계열 DBMS엔 대상 테이블이 없어 스킵합니다.
    if ( sql.includes('ogg_discard_log') && dbconfig[5].includes('VAN') ) {
      continue;
    }

    try {
      const result = await dbmsList.getMonResult(dbmsid, id, sql);
      results.push({
        task_id: id,
        task_name: checkName,
        columns: result.columns,
        rows: applyThresholds(result.rows, thresholdsByTask[id]),
        success: true
      });
    } catch (error) {
      console.error(`Service : 태스크(${id}:${checkName}) 실행 실패:`, error);
      results.push({
        task_id: id,
        task_name: checkName,
        columns: [],
        rows: [],
        success: false,
        error: error.message
      });
    }
  }

  return results;
}

async function addDbms(dbmsInfo) {
  try {
    const result = await dbmsList.addDbms(dbmsInfo);
    return result;
  } catch (error) {
    console.error('Service : DBMS 등록 실패:', error);
    throw new Error('Service : DBMS 등록 실패', { cause: error });
  }
}

async function modifyDbms(dbmsInfo) {
  try {
    const result = await dbmsList.modifyDbms(dbmsInfo);
    return result;
  } catch (error) {
    console.error('Service : DBMS 수정 실패:', error);
    throw new Error('Service : DBMS 수정 실패', { cause: error });
  }
}

async function modifyScript(scriptInfo) {
  try {
    const result = await dbmsList.modifyScript(scriptInfo);
    return result;
  } catch (error) {
    console.error('Service : 스크립트 수정 실패:', error);
    throw new Error('Service : 스크립트 수정 실패', { cause: error });
  }
}

async function deleteDbms(dbmsId) {
  try {
    const result = await dbmsList.deleteDbms(dbmsId);
    return result;
  } catch (error) {
    console.error('Service : DBMS 삭제 실패:', error);
    throw new Error('Service : DBMS 삭제 실패', { cause: error });
  }
}

async function addScript(scriptInfo) {
  try {
    const result = await dbmsList.addScript(scriptInfo);
    return result;
  } catch (error) {
    console.error('Service : 스크립트 등록 실패:', error);
    throw new Error('Service : 스크립트 등록 실패', { cause: error });
  }
}

async function deleteScript(scriptId) {
  try {
    const result = await dbmsList.deleteScript(scriptId);
    return result;
  } catch (error) {
    console.error('Service : 스크립트 삭제 실패:', error);
    throw new Error('Service : 스크립트 삭제 실패', { cause: error });
  }
}

async function getThresholds() {
  try {
    const thresholds = await dbmsList.getThresholds();
    return thresholds;
  } catch (error) {
    console.error('Service : 임계치 목록 조회 실패:', error);
    throw new Error('임계치 목록 조회 실패', { cause: error });
  }
}

async function addThreshold(thresholdInfo) {
  try {
    const result = await dbmsList.addThreshold(thresholdInfo);
    return result;
  } catch (error) {
    console.error('Service : 임계치 등록 실패:', error);
    throw new Error('Service : 임계치 등록 실패', { cause: error });
  }
}

async function modifyThreshold(thresholdInfo) {
  try {
    const result = await dbmsList.modifyThreshold(thresholdInfo);
    return result;
  } catch (error) {
    console.error('Service : 임계치 수정 실패:', error);
    throw new Error('Service : 임계치 수정 실패', { cause: error });
  }
}

async function deleteThreshold(thresholdId) {
  try {
    const result = await dbmsList.deleteThreshold(thresholdId);
    return result;
  } catch (error) {
    console.error('Service : 임계치 삭제 실패:', error);
    throw new Error('Service : 임계치 삭제 실패', { cause: error });
  }
}

module.exports = {
    getAllDbmses, getDbmsInfo, getMonResult, addDbms, modifyDbms, deleteDbms, listTasks, getScripts, getSqlText, modifyScript, addScript, deleteScript
    , getThresholds, addThreshold, modifyThreshold, deleteThreshold
};
