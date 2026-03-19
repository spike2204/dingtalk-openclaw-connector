#!/usr/bin/env node

/**
 * 钉钉连接测试脚本
 * 用于诊断 "HTTP request sent to HTTPS port" 问题
 */

import axios from 'axios';
import https from 'https';
import http from 'http';

console.log('='.repeat(60));
console.log('钉钉连接诊断测试');
console.log('='.repeat(60));
console.log('');

// 1. 检查环境变量
console.log('1. 环境变量检查');
console.log('---');
console.log(`HTTP_PROXY: ${process.env.HTTP_PROXY || '未设置'}`);
console.log(`HTTPS_PROXY: ${process.env.HTTPS_PROXY || '未设置'}`);
console.log(`http_proxy: ${process.env.http_proxy || '未设置'}`);
console.log(`https_proxy: ${process.env.https_proxy || '未设置'}`);
console.log(`NO_PROXY: ${process.env.NO_PROXY || '未设置'}`);
console.log('');

// 2. 检查 Node.js 版本
console.log('2. Node.js 版本');
console.log('---');
console.log(`Node.js: ${process.version}`);
console.log('');

// 3. 测试 axios 默认配置
console.log('3. axios 默认配置');
console.log('---');
console.log(`axios.defaults.proxy: ${JSON.stringify(axios.defaults.proxy || '未设置')}`);
console.log(`axios.defaults.httpAgent: ${axios.defaults.httpAgent ? '已设置' : '未设置'}`);
console.log(`axios.defaults.httpsAgent: ${axios.defaults.httpsAgent ? '已设置' : '未设置'}`);
console.log('');

// 4. 测试直接请求钉钉 API
console.log('4. 测试钉钉 Gateway API');
console.log('---');

const GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open';

try {
  console.log(`请求 URL: ${GATEWAY_URL}`);
  console.log('发送 POST 请求...');
  
  const response = await axios({
    url: GATEWAY_URL,
    method: 'POST',
    responseType: 'json',
    data: {
      clientId: 'test',
      clientSecret: 'test',
      ua: 'test',
      subscriptions: [{ type: 'EVENT', topic: '*' }]
    },
    headers: {
      'Accept': 'application/json'
    },
    // 显式设置 HTTPS agent
    httpsAgent: new https.Agent({
      rejectUnauthorized: true
    }),
    // 确保不使用 HTTP agent
    httpAgent: undefined,
    // 禁用代理
    proxy: false,
    timeout: 10000
  });
  
  console.log(`✅ 请求成功！`);
  console.log(`状态码: ${response.status}`);
  console.log(`响应数据: ${JSON.stringify(response.data).substring(0, 200)}...`);
} catch (error) {
  console.log(`❌ 请求失败！`);
  console.log(`错误类型: ${error.constructor.name}`);
  console.log(`错误消息: ${error.message}`);
  
  if (error.response) {
    console.log(`响应状态码: ${error.response.status}`);
    console.log(`响应数据: ${typeof error.response.data === 'string' ? error.response.data.substring(0, 500) : JSON.stringify(error.response.data)}`);
  }
  
  if (error.code) {
    console.log(`错误代码: ${error.code}`);
  }
  
  if (error.config) {
    console.log(`请求配置:`);
    console.log(`  - URL: ${error.config.url}`);
    console.log(`  - Method: ${error.config.method}`);
    console.log(`  - Proxy: ${JSON.stringify(error.config.proxy)}`);
    console.log(`  - httpAgent: ${error.config.httpAgent ? '已设置' : '未设置'}`);
    console.log(`  - httpsAgent: ${error.config.httpsAgent ? '已设置' : '未设置'}`);
  }
}

console.log('');
console.log('='.repeat(60));
console.log('诊断完成');
console.log('='.repeat(60));
