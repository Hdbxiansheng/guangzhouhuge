// Vercel 云端入口：把 Express 应用包装成 serverless 函数
const serverless = require('serverless-http');
const app = require('../server/app');
module.exports = serverless(app);
