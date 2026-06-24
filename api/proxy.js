// api/proxy.js
const crypto = require('crypto');
const WebSocket = require('ws');

// 從環境變數讀取金鑰
const APPID = process.env.XUNFEI_APPID;
const API_KEY = process.env.XUNFEI_API_KEY;
const API_SECRET = process.env.XUNFEI_API_SECRET;
const IAT_URL = 'wss://iat-api.xfyun.cn/v2/iat';
const SPARK_URL = 'wss://spark-api.xf-yun.com/v4.0/chat';

// 構建 WebSocket 簽名 URL
function buildWsUrl(host, path, apiKey, apiSecret) {
    const date = new Date().toUTCString();
    const requestLine = `GET ${path} HTTP/1.1`;
    const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
    const hmac = crypto.createHmac('sha256', apiSecret);
    hmac.update(signatureOrigin);
    const signature = hmac.digest('base64');
    const authorizationOrigin = `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
    const authorization = Buffer.from(authorizationOrigin).toString('base64');
    return `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&host=${host}&date=${encodeURIComponent(date)}`;
}

// 語音識別（僅當 audioBase64 非空）
function recognizeAudio(audioBase64) {
    return new Promise((resolve, reject) => {
        if (!audioBase64) {
            resolve('');  // 無音頻，返回空
            return;
        }
        const urlObj = new URL(IAT_URL);
        const wsUrl = buildWsUrl(urlObj.host, urlObj.pathname, API_KEY, API_SECRET);
        const ws = new WebSocket(wsUrl);
        let transcript = '';
        let finished = false;

        ws.on('open', () => {
            ws.send(JSON.stringify({
                common: { app_id: APPID },
                business: { language: 'zh_cn', domain: 'iat', accent: 'mandarin' },
                data: { status: 0, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' }
            }));
            const audioBuffer = Buffer.from(audioBase64, 'base64');
            const chunkSize = 4000;
            let offset = 0;
            while (offset < audioBuffer.length) {
                const chunk = audioBuffer.slice(offset, offset + chunkSize);
                ws.send(JSON.stringify({
                    data: { status: 1, format: 'audio/L16;rate=16000', encoding: 'raw', audio: chunk.toString('base64') }
                }));
                offset += chunkSize;
            }
            ws.send(JSON.stringify({
                data: { status: 2, format: 'audio/L16;rate=16000', encoding: 'raw', audio: '' }
            }));
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.code && msg.code !== 0) {
                    reject(new Error(`IAT error: ${msg.code}`));
                    return;
                }
                if (msg.data && msg.data.result && msg.data.result.ws) {
                    let text = '';
                    for (const w of msg.data.result.ws) {
                        for (const cw of w.cw) text += cw.w;
                    }
                    transcript += text;
                }
                if (msg.data && msg.data.status === 2) {
                    finished = true;
                    ws.close();
                    resolve(transcript);
                }
            } catch (e) {
                reject(e);
            }
        });

        ws.on('error', (err) => reject(err));
        ws.on('close', () => {
            if (!finished) reject(new Error('IAT connection closed without result'));
        });

        setTimeout(() => {
            if (!finished) {
                ws.close();
                reject(new Error('IAT timeout'));
            }
        }, 15000);
    });
}

// 星火評分（文字模式）
function scoreAnswer(questionInfo, answerText) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(SPARK_URL);
        const wsUrl = buildWsUrl(urlObj.host, urlObj.pathname, API_KEY, API_SECRET);
        const ws = new WebSocket(wsUrl);
        let resultText = '';
        let finished = false;

        let prompt = '';
        if (questionInfo.type === 'open') {
            prompt = `你是一位專業的普通話教師，請用鼓勵性語氣評分。\n題目類型：開放式看圖說故事\n主題：${questionInfo.refAnswer || ''}\n關鍵字：${(questionInfo.keywords||[]).join('、')}\n學生回答：${answerText}\n請從內容相關性、豐富度、語音準確度三項評分(0-10)，給出總分(0-10)，並提供具體建議(繁體中文，50-100字，鼓勵為主)。\n輸出JSON：{"accuracy":分數,"fluency":分數,"integrity":分數,"total_score":平均分,"suggestion":"建議"}`;
        } else {
            // 半固定式：需要對每個子問題分別評分，但我們接收的 answerText 是合併的，需要拆分或整體評分。
            // 簡單起見，我們整體評分，並給出子分數（模擬）
            prompt = `你是一位專業的普通話教師，請用鼓勵性語氣評分。\n題目：半固定式看圖答問題\n${questionInfo.subQuestions.map((sq, i) => `子問題${i+1}：${sq.question}  參考答案：${sq.answer||''}  關鍵字：${(sq.keywords||[]).join('、')}`).join('\n')}\n學生回答：${answerText}\n請對每個子問題分別給分（內容相關性、豐富度、語音準確度）(0-10)，並給出總分(0-10)和整體建議(繁體中文，鼓勵為主)。\n輸出JSON格式：\n{"sub_scores":[{"accuracy":分數,"fluency":分數,"integrity":分數},...],"total_score":平均分,"suggestion":"整體建議"}`;
        }

        ws.on('open', () => {
            ws.send(JSON.stringify({
                header: { app_id: APPID, uid: 'student' },
                parameter: { chat: { domain: '4.0Ultra', temperature: 0.3, max_tokens: 1024, top_k: 5 } },
                payload: { message: { text: [ { role: 'system', content: '你是一位專業的普通話教師。' }, { role: 'user', content: prompt } ] } }
            }));
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.header && msg.header.code !== 0) {
                    reject(new Error(`Spark error: ${msg.header.code}`));
                    return;
                }
                if (msg.payload && msg.payload.choices && msg.payload.choices.text) {
                    for (const t of msg.payload.choices.text) {
                        resultText += t.content;
                    }
                }
                if (msg.header && msg.header.status === 2) {
                    finished = true;
                    ws.close();
                    resolve(resultText);
                }
            } catch (e) {
                reject(e);
            }
        });

        ws.on('error', (err) => reject(err));
        ws.on('close', () => {
            if (!finished) reject(new Error('Spark connection closed without result'));
        });

        setTimeout(() => {
            if (!finished) {
                ws.close();
                reject(new Error('Spark timeout'));
            }
        }, 20000);
    });
}

// Vercel 入口
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const { audioBase64, question, textAnswer } = req.body;
        if (!question) {
            res.status(400).json({ error: 'Missing question' });
            return;
        }

        // 語音識別（若有音頻）
        let transcript = '';
        if (audioBase64) {
            transcript = await recognizeAudio(audioBase64);
        } else if (textAnswer) {
            transcript = textAnswer;  // 直接使用傳入的文字
        }

        // 評分
        const answerForScore = transcript || textAnswer || '';
        const scoreRaw = await scoreAnswer(question, answerForScore);
        let scoreJSON;
        try {
            let jsonStr = scoreRaw.trim();
            jsonStr = jsonStr.replace(/^```json\s*/, '').replace(/\s*```$/, '');
            const match = jsonStr.match(/\{[\s\S]*\}/);
            if (match) jsonStr = match[0];
            scoreJSON = JSON.parse(jsonStr);
        } catch (e) {
            scoreJSON = { error: '評分解析失敗', raw: scoreRaw };
        }

        res.status(200).json({
            transcript: transcript,
            score: scoreJSON
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};