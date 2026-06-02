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
    throw new Error('사용자 목록 조회 실패');
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
    throw new Error('사용자 목록 조회 실패');
  }
}


async function getDbmsInfo(dbmsid) {
  try {
    const  dbconfig = await dbmsList.getDbmsInfo(dbmsid);
    return dbconfig;
  } catch (error) {
    throw new Error('DBMS 정보 가져오기 실패');
  }
}

async function getSqlText(scriptid) {
  try {
    const  sql = await dbmsList.getSqlText(scriptid);
    console.log('Get SQL TEXT', sql );
    return sql;
  } catch (error) {
    throw new Error('script 정보 가져오기 실패');
  }
}

async function listTasks() {
  try {
    console.log('system.listTasks 서비스 함수');
    const  results = await dbmsList.listTasks();
    return results;
  } catch (error) {
    throw new Error('Tasks 가져오기 실패 ');
  }
}


async function getMonResult(dbmsid) {
  const results = []; // 객체 키:값
  //console.log( queries ); 
  try {
    const dbconfig = await getDbmsInfo(dbmsid);
    console.log('listTasks');
    const tasks  = await listTasks(); 
    //console.log(tasks.rows);
    for ( const row of tasks.rows ) {
      const id = row[0]; 
      const checkName = row[1]; 
    //  console.log('SQL id :   ',row[0]);
    //  console.log('SQL name :   ',row[1]);
    //  console.log('SQL sql_text :   ',row[2]);
        
      const sql = row[2];

      console.log('SQL :   ', sql);
      if ( sql.includes('ogg_discard_log') ) { 
        if ( dbconfig[5].includes('VAN') ) {
          console.log('ogg_discard_log and van dbms : ', sql.includes('ogg_discard_log') );
          continue;
        }
        
        const result = await dbmsList.getMonResult(dbmsid, id, sql);
        const columns = result.metaData.map(col => col.name);
        const rows = result.rows;
        
        //results.push(result); // rows만 저장
        results.push({
          task_id: id,
          task_name: checkName,
          columns,
          rows,
          success: true
        });

      } 
      else {
          const result = await dbmsList.getMonResult(dbmsid, id, sql);
          //console.log('result :   ', result);
          const columns = result.columns; 
          //console.log('columns :   ', result.columns);
          const rows = result.rows;
          //console.log('dbmsService getMonResult result: ' , result ) ; 
          //results.push(result); // rows만 저장
          //results[checkName] = result;
          results.push({
            task_id: id,
            task_name: checkName,
            columns,
            rows,
            success: true
          });
      }

    }
    return results;
  } catch (error) {
    throw new Error('Monitoring Result 가져오기 실패', error);
  }
}

async function addDbms(dbmsInfo) {
  try {
    const result = await dbmsList.addDbms(dbmsInfo);
    return result; 
  } catch (error) {
    throw new Error('Service : DBMS 등록 실패');
  }
}

async function modifyDbms(dbmsInfo) {
  try {
    const result = await dbmsList.modifyDbms(dbmsInfo);
    return result; 
  } catch (error) {
    throw new Error('Service : DBMS 등록 실패');
  }
}

async function modifyScript(scriptInfo) {
  try {
    const result = await dbmsList.modifyScript(scriptInfo);
    return result; 
  } catch (error) {
    throw new Error('Service : DBMS 등록 실패');
  }
}

async function deleteDbms(dbmsId) {
  try {
    const result = await dbmsList.deleteDbms(dbmsId);
    return result; 
  } catch (error) {
    throw new Error('Service : DBMS 삭제 실패');
  }
}

async function addScript(scriptInfo) {
  try {
    const result = await dbmsList.addScript(scriptInfo);
    return result; 
  } catch (error) {
    throw new Error('Service : 스크립트 등록 실패');
  }
}

async function deleteScript(scriptId) {
  try {
    const result = await dbmsList.deleteScript(scriptId);
    return result; 
  } catch (error) {
    throw new Error('Service : 스크립트 삭제 실패');
  }
}

module.exports = {
    getAllDbmses, getDbmsInfo, getMonResult, addDbms, modifyDbms, deleteDbms, listTasks, getScripts, getSqlText, modifyScript, addScript, deleteScript
};
