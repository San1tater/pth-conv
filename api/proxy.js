const crypto = require('crypto');
const WebSocket = require('ws');

const APPID = process.env.XUNFEI_APPID;
const API_KEY = process.env.XUNFEI_API_KEY;
const API_SECRET = process.env.XUNFEI_API_SECRET;
const SPARK_URL = 'wss://spark-api.xf-yun.com/v4.0/chat';

function scoreAnswer(questionInfo, answerText) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(SPARK_URL);
        const host = urlObj.host;
        const path = urlObj.pathname;
        const date = new Date().toUTCString();
        const requestLine = `GET ${path} HTTP/1.1`;
        const signatureOrigin = `host: ${host}\ndate: ${date}\n${requestLine}`;
        const hmac = crypto.createHmac('sha256', API_SECRET);
        hmac.update(signatureOrigin);
        const signature = hmac.digest('base64');
        const authorizationOrigin = `api_key="${API_KEY}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
        const authorization = Buffer.from(authorizationOrigin).toString('base64');
        const wsUrl = `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&host=${host}&date=${encodeURIComponent(date)}`;

        const ws = new WebSocket(wsUrl);
        let resultText = '';
        let finished = false;

        let prompt = '';
        if (questionInfo.type === 'open') {
            prompt = `你是一位專業的普通話教師，請用鼓勵性語氣評分。\n題目類型：開放式看圖說故事\n主題：${questionInfo.refAnswer || ''}\n關鍵字：${(questionInfo.keywords||[]).join('、')}\n學生回答：${answerText}\n請從內容相關性、豐富度、語音準確度三項評分(0-10)，給出總分(0-10)，並提供具體建議。\n要求：\n1. 建議必須使用繁體中文標準書面語，不得使用任何粵語口語（如「嘅」、「咁」、「佢」等）。\n2. 評分結果請以 JSON 格式輸出，格式：{"accuracy":分數,"fluency":分數,"integrity":分數,"total_score":平均分,"suggestion":"建議"}`;
        } else {
            const subQs = questionInfo.subQuestions || [];
            let subPrompt = '';
            subQs.forEach((sq, i) => {
                subPrompt += `子問題${i+1}：${sq.question}\n參考答案：${sq.answer||''}\n關鍵字：${(sq.keywords||[]).join('、')}\n`;
            });
            prompt = `你是一位專業的普通話教師，請用鼓勵性語氣評分。\n題目：半固定式看圖答問題\n${subPrompt}\n學生回答（逐題）：\n${answerText}\n請對每個子問題分別給出分數（內容相關性、豐富度、語音準確度）(0-10)和具體評語（繁體中文標準書面語，不得使用粵語口語），並給出總分(0-10)和整體建議。\n輸出JSON格式：\n{"sub_scores":[{"accuracy":分數,"fluency":分數,"integrity":分數,"comment":"評語"},...],"total_score":平均分,"suggestion":"整體建議"}`;
        }

        ws.on('open', () => {
            ws.send(JSON.stringify({
                header: { app_id: APPID, uid: 'student' },
                parameter: { chat: { domain: '4.0Ultra', temperature: 0.3, max_tokens: 1024, top_k: 5 } },
                payload: { message: { text: [ { role: 'system', content: '你是一位專業的普通話教師，必須使用繁體中文標準書面語。' }, { role: 'user', content: prompt } ] } }
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

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }

    try {
        const { question, textAnswer } = req.body;
        if (!question || !textAnswer) {
            res.status(400).json({ error: 'Missing question or textAnswer' });
            return;
        }
        const hasChinese = /[\u4e00-\u9fa5]/.test(textAnswer);
        if (!hasChinese) {
            const subCount = (question.subQuestions || []).length;
            const subScores = subCount > 0 ? question.subQuestions.map(() => ({ accuracy: 0, fluency: 0, integrity: 0, comment: '未使用普通話作答' })) : [];
            res.status(200).json({
                score: {
                    total_score: 0,
                    suggestion: '檢測到英文或非中文回應，請以普通話作答。',
                    sub_scores: subScores
                }
            });
            return;
        }
        const scoreRaw = await scoreAnswer(question, textAnswer);
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
        res.status(200).json({ score: scoreJSON });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
