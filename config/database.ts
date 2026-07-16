// 오라클 DB 설정 파일

export interface DbConfig {
  user: string;
  password: string;
  connectString: string;
  externalAuth: boolean;
}

const dbConfig: DbConfig = {
  user: process.env.NODE_ORACLEDB_USER || 'system',
  password: process.env.NODE_ORACLEDB_PASSWORD || 'We1come$',
  connectString: process.env.NODE_ORACLEDB_CONNECTIONSTRING || '172.32.22.30:5002/DEVTEST',
  externalAuth: process.env.NODE_ORACLEDB_EXTERNALAUTH ? true : false,
};

module.exports = dbConfig;
