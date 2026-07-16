import express from 'express';
import * as tableSpecController from '../controllers/tableSpecController';

const router = express.Router();

router.post('/tableSpec/schemas', tableSpecController.getSchemas);
router.post('/tableSpec/tables', tableSpecController.getTables);
router.post('/tableSpec/download', tableSpecController.downloadTableSpec);

export default router;
