const crypto = require('crypto');
const WebSocket = require('ws');

const APPID = process.env.XUNFEI_APPID;
const API_KEY = process.env.XUNFEI_API_KEY;
const API_SECRET = process.env.XUNFEI_API_SECRET;
const SPARK_URL = 'wss://spark-api.xf-yun.com/v4.0/chat';

/**
 * 僅組裝動態 user 訊息（不含任何評分規則，規則已在調適中心預設）
 */
function buildDynamicUserMessage(questionInfo, answerText, lang) {
    const isOpen = questionInfo.type === 'open';
    let userContent = '';

    if (isOpen) {
        userContent = `題型：開放式看圖說故事
參考答案：${questionInfo.refAnswer || ''}
關鍵字（可能含干擾項）：${(questionInfo.keywords || []).join('、')}
學生轉寫：${answerText}

請依預設規則輸出 JSON。`;
    } else {
        let subText = '';
        (questionInfo.subQuestions || []).forEach((sq, i) => {
            subText += `子問題${i+1}：${sq.question}\n參考答案：${sq.answer || ''}\n關鍵字：${(sq.keywords || []).join('、')}\n`;
        });
        userContent = `題型：半固定式看圖答問題\n${subText}\n學生轉寫（逐題）：${answerText}

請依預設規則輸出 JSON。`;
    }

    // 明確標示當前語言，讓模型根據預設指令決定輸出語言
    const langHint = lang === 'en' ? 'Current language: English' : '當前語言：繁體中文';
    userContent += `\n\n${langHint}`;

    return userContent;
}

/**
 * 呼叫星火大模型進行評分（僅發送 user 訊息）
 */
function scoreAnswer(questionInfo, answerText, lang) {
    return new Promise((resolve, reject) => {
        // 截斷文字避免過長
        let truncated = answerText;
        if (answerText.length > 200) {
            truncated = answerText.substring(0, 200) + '...(截斷)';
        }

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

        const userMessage = buildDynamicUserMessage(questionInfo, truncated, lang);

        ws.on('open', () => {
            ws.send(JSON.stringify({
                header: { app_id: APPID, uid: 'student' },
                parameter: { chat: { domain: '4.0Ultra', temperature: 0.3, max_tokens: 1024, top_k: 5 } },
                payload: {
                    message: {
                        text: [
                            // 不再發送 system，完全依賴調適中心預設指令
                            { role: 'user', content: userMessage }
                        ]
                    }
                }
            }));
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data);
                if (msg.header && msg.header.code !== 0) {
                    reject(new Error(`Spark 錯誤碼: ${msg.header.code}`));
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
            if (!finished) reject(new Error('Spark 連線關閉，未取得結果'));
        });

        // 超時 30 秒
        setTimeout(() => {
            if (!finished) {
                ws.close();
                reject(new Error('Spark 請求逾時'));
            }
        }, 30000);
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
        res.status(405).json({ error: '不允許的 HTTP 方法' });
        return;
    }

    try {
        const { question, textAnswer, lang } = req.body;
        if (!question || !textAnswer) {
            res.status(400).json({ error: '缺少 question 或 textAnswer' });
            return;
        }

        const useLang = (lang === 'en') ? 'en' : 'zh';

        // 檢測中文
        const hasChinese = /[\u4e00-\u9fa5]/.test(textAnswer);
        if (!hasChinese) {
            const subCount = (question.subQuestions || []).length;
            const subScores = subCount > 0 ? question.subQuestions.map(() => ({
                accuracy: 0.0,
                completeness: 0.0,
                integrity: 0.0,
                comment: useLang === 'zh' ? '未使用普通話作答' : 'Not answered in Mandarin'
            })) : [];
            const suggestion = useLang === 'zh'
                ? '檢測到英文或非中文回應，請以普通話作答。'
                : 'English or non-Chinese detected, please answer in Mandarin.';
            res.status(200).json({
                score: {
                    total_score: 0.0,
                    suggestion: suggestion,
                    sub_scores: subScores
                }
            });
            return;
        }

        const scoreRaw = await scoreAnswer(question, textAnswer, useLang);
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
