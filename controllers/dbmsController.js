const dbmsService = require('../services/dbmsService');

// 모든 dbms 가져오기
async function getAllDbmses(req, res) {
    try {
      const dbmses = await dbmsService.getAllDbmses();  // 서비스 호출
      res.status(200).json(dbmses);  // JSON 형식으로 응답
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

  // <--! 모니터링 스크립트 가져오기 --> 
  async function getScripts(req, res) {
    try {
      console.log( 'getScripts Controller !!!!!')
      const scripts = await dbmsService.getScripts();  // 서비스 호출
      res.status(200).json(scripts);  // JSON 형식으로 응답
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  }

async function getDbmsInfo(req, res) {
    try {
      const { dbname, sid, ip } = req.body;
      console.log( dbname );
      // 필수 데이터 유효성 검사
      if (!dbname || !sid || !ip ) {
        return res.status(400).json({ message: 'DBMS 정보가 필요합니다.' });
      }
     // JSON 형태로 서비스 호출
     const queryData = { dbname, sid, ip }; // JSON 변수로 서비스에 전달
     const dbconfig = await dbmsService.getDbmsInfo(queryData);
      // 사용자 정보가 없을 경우
    if (!dbconfig) {
        return res.status(404).json({ message: 'DBMS 찾을 수 없습니다.' });
      }
      // 조회된 사용자 정보를 클라이언트로 응답
      res.status(200).json({ message: 'DBMS 조회 성공', dbconfig });
    } catch (error) {
      console.error('DBMS 조회 중 오류:', error);
      res.status(500).json({ message: '서버 오류 발생' });
    }
  }



  async function getMonResult(req, res) {
    try {
      const dbmsid = req.body;
      
      // 필수 데이터 유효성 검사
      if (!dbmsid ) {
        return res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
      }

     // JSON 형태로 서비스 호출
     //const queryData = { dbname, sid, ip, memo }; // JSON 변수로 서비스에 전달

     
     const queryResults = await dbmsService.getMonResult(dbmsid);
     
     res.json(queryResults);

    } catch (error) {
      console.error('DBMS 조회 중 오류:', error);
      res.status(500).json({ message: '서버 오류 발생' });
    }
  }
  
  async function addDbms(req, res) {
    try {

      const { dbname, username, password, sid, ip, port, memo } = req.body;

      const dbmsInfo = {  dbname, username, password, sid, ip, port, memo }; // JSON 변수로 서비스에 전달
      console.error('Controller :dbmsInfo:', dbmsInfo );
      const queryResults = await dbmsService.addDbms(dbmsInfo);
      console.log('Controller : result  ', queryResults);
     
      return res.json(queryResults);


    } catch (error) {
      console.error('Controller : DB등록 오류:', error);
      res.status(500).json({ message: 'Controller : 서버 오류 발생' });
    }

  }

  async function modifyDbms(req, res) {
    try {

      const { id, dbname, username, password, sid, ip, port, memo }   = req.body;
      const dbmsInfo = {  id, dbname, username, password, sid, ip, port, memo }; 
      //const dbmsId = { dbmsId } = req.body; ; // JSON 변수로 서비스에 전달
      console.error('Controller :dbmsInfo:', dbmsInfo );
      const queryResults = await dbmsService.modifyDbms(dbmsInfo);
      console.log('Controller : result  ', queryResults);
     
      return res.json(queryResults);
      
    } catch (error) {
      console.error('Controller : DB등록 오류:', error);
      res.status(500).json({ message: 'Controller : 서버 오류 발생' });
    }

  }

  async function deleteDbms(req, res) {
    try {

      const dbmsId  = req.body;

      //const dbmsId = { dbmsId } = req.body; ; // JSON 변수로 서비스에 전달
      console.error('Controller :dbmsInfo:', dbmsId );
      const queryResults = await dbmsService.deleteDbms(dbmsId);
      console.log('Controller : result  ', queryResults);
     
      return res.json(queryResults);
      

    } catch (error) {
      console.error('Controller : DB등록 오류:', error);
      res.status(500).json({ message: 'Controller : 서버 오류 발생' });
    }
  }

  async function modifyScript(req, res) {
    try {

      const scriptInfo = {  id, name, category, description, sql_text, schedule, is_active } = req.body;
      
      console.error('Controller : ScriptInfo:', scriptInfo );
      const queryResults = await dbmsService.modifyScript(scriptInfo);
      console.log('Controller : Script result  ', queryResults);
     
      return res.json(queryResults);
      
    } catch (error) {
      console.error('Controller : DB등록 오류:', error);
      res.status(500).json({ message: 'Controller : 서버 오류 발생' });
    }

  }

  async function getSqlText(req, res) {
    try {
      const { id, name } = req.body;
      console.log( name );
      // 필수 데이터 유효성 검사
      if (!id || !name ) {
        return res.status(400).json({ message: 'Script 정보가 필요합니다.' });
      }
     // JSON 형태로 서비스 호출
     const queryData = { id, name }; // JSON 변수로 서비스에 전달
     const scriptconfig = await dbmsService.getSqlText(queryData);
      // 사용자 정보가 없을 경우
    if (!scriptconfig) {
        return res.status(404).json({ message: 'Script 찾을 수 없습니다.' });
      }
      // 조회된 사용자 정보를 클라이언트로 응답
      res.status(200).json({ message: 'Script 조회 성공', scriptconfig });
    } catch (error) {
      console.error('Script 조회 중 오류:', error);
      res.status(500).json({ message: '서버 오류 발생' });
    }
  }

  async function addScript(req, res) {
    try {

      const { id, name, category, description, sql_text, schedule, is_active } = req.body;

      const scriptInfo = {  id, name, category, description, sql_text, schedule, is_active }; // JSON 변수로 서비스에 전달
      console.error('Controller :dbmsInfo:', scriptInfo );
      const queryResults = await dbmsService.addScript(scriptInfo);
      console.log('Controller : result  ', queryResults);
     
      return res.json(queryResults);


    } catch (error) {
      console.error('Controller : 스크립트 등록 오류:', error);
      res.status(500).json({ message: 'Controller : 서버 오류 발생' });
    }

  }

  async function deleteScript(req, res) {
    try {

      const scriptId  = req.body;

      //const dbmsId = { dbmsId } = req.body; ; // JSON 변수로 서비스에 전달
      console.error('Controller :scriptId :', scriptId );
      const queryResults = await dbmsService.deleteScript(scriptId);
      console.log('Controller : result  ', queryResults);
     
      return res.json(queryResults);
      

    } catch (error) {
      console.error('Controller : 스크립트 삭제 오류:', error);
      res.status(500).json({ message: 'Controller : 서버 오류 발생' });
    }
  }

  module.exports = {
    getAllDbmses, getDbmsInfo, getMonResult, addDbms, modifyDbms, deleteDbms, getScripts, modifyScript, getSqlText, addScript, deleteScript
  };