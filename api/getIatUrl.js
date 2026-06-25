const crypto = require('crypto');

// 从环境变量读取密钥（Vercel 中设置）
const APPID = process.env.XUNFEI_APPID;
const API_KEY = process.env.XUNFEI_API_KEY;
const API_SECRET = process.env.XUNFEI_API_SECRET;
const IAT_URL = 'wss://iat-api.xfyun.cn/v2/iat';

function buildIatUrl() {
    const host = new URL(IAT_URL).host;
    const path = new URL(IAT_URL).pathname;
    const date = new Date().toUTCString();
    const requestLine = `GET ${path} HTTP/1.1`;
    const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
    const hmac = crypto.createHmac('sha256', API_SECRET);
    hmac.update(signatureOrigin);
    const signature = hmac.digest('base64');
    const authorizationOrigin = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = Buffer.from(authorizationOrigin).toString('base64');
    return `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&host=${host}&date=${encodeURIComponent(date)}`;
}

module.exports = async (req, res) => {
    // CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const url = buildIatUrl();
        res.status(200).json({ url });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
