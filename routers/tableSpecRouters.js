const express = require('express');
const router = express.Router();
const tableSpecController = require('../controllers/tableSpecController');

router.post('/tableSpec/schemas', tableSpecController.getSchemas);
router.post('/tableSpec/tables', tableSpecController.getTables);
router.post('/tableSpec/download', tableSpecController.downloadTableSpec);

module.exports = router;
