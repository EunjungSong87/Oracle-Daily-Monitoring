// function readClobAsString(clob) {
//     return new Promise((resolve, reject) => {
//       if (clob === null) return resolve(null);
  
//       let data = '';

//       console.log('IN readClobAsString Function !!!!!! '); 
  
//       clob.setEncoding('utf8');
//       clob.on('data', chunk => data += chunk);
//       clob.on('end', () => resolve(data));
//       clob.on('error', err => reject(err));
//     });
//   }

// async function readClobAsString(lob) {
//   if (lob === null) return null;
//     lob.setEncoding('utf8');
//     try {
//       let str = '';
//       for await (const chunk of lob) {
//         str += chunk;
//       }
//       return str;
//     } catch (error) {
//       throw new Error('CLOB 변환 실패 ');
//     }
// }


function readClobAsString(clob) {
  return new Promise((resolve, reject) => {
    if (clob === null) return resolve(null);

    let data = '';

    clob.setEncoding('utf8');
    clob.on('data', chunk => data += chunk);
    clob.on('end', () => resolve(data));
    clob.on('error', err => reject(err));
  });
}

module.exports = { readClobAsString };