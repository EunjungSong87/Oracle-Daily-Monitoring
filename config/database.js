// 오라클 DB 설정 파일 

module.exports = {   user			:process.env.NODE_ORACLEDB_USER             || "system",		
                     password		:process.env.NODE_ORACLEDB_PASSWORD         || "We1come$",		
                     connectString	:process.env.NODE_ORACLEDB_CONNECTIONSTRING || "172.32.22.30:5002/DEVTEST",		
                     externalAuth	:process.env.NODE_ORACLEDB_EXTERNALAUTH ? true : false
                 };
 