const tableSpecService = require('../services/tableSpecService');

async function getSchemas(req, res) {
  try {
    const { dbmsid } = req.body;
    if (!dbmsid) {
      return res.status(400).json({ message: 'dbmsid 정보가 필요합니다.' });
    }
    const schemas = await tableSpecService.getSchemas({ dbmsid });
    res.status(200).json(schemas);
  } catch (error) {
    console.error('Controller : 스키마 목록 조회 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function getTables(req, res) {
  try {
    const { dbmsid, owner } = req.body;
    if (!dbmsid || !owner) {
      return res.status(400).json({ message: 'dbmsid, owner 정보가 필요합니다.' });
    }
    const tables = await tableSpecService.getTables({ dbmsid }, owner);
    res.status(200).json(tables);
  } catch (error) {
    console.error('Controller : 테이블 목록 조회 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

async function downloadTableSpec(req, res) {
  try {
    const { dbmsid, owner, tables } = req.body;
    if (!dbmsid || !owner || !tables) {
      return res.status(400).json({ message: 'dbmsid, owner, tables 정보가 필요합니다.' });
    }
    const workbook = await tableSpecService.buildTableSpecWorkbook({ dbmsid }, owner, tables);

    const filename = `${owner}_table_spec_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Controller : 테이블 명세서 다운로드 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
}

module.exports = { getSchemas, getTables, downloadTableSpec };
