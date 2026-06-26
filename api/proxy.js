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
            prompt = `你是一位專業的普通話教師，請用鼓勵性語氣評分。

題目類型：開放式看圖說故事
主題：${questionInfo.refAnswer || ''}
關鍵字：${(questionInfo.keywords||[]).join('、')}
學生回答：${answerText}

請從以下三個維度分別給分（每項0-10分，精確到小數點後一位）：
1. 內容相關性（accuracy）：是否緊扣主題和關鍵字，敘事完整。
2. 豐富度（fluency）：詞彙多樣性、細節描述、情節發展。
3. 語音準確度（integrity）：**請注意，你只能看到轉寫後的文字，無法聽到真實語音。因此，請根據文字中是否存在錯別字、用詞不當或不合語境的情況來推斷可能的語音錯誤（如發音近似導致的別字）。若發現此類問題，請在建議中溫和地指出，並詢問學生原本是否想表達某個特定詞語。若文字內容完全無法理解（意義不明或嚴重離題），則可能代表語音準確度極低或完全跑題，請據實給予低分。**

最後給出總分（0-10，可為平均分或綜合評定，精確到小數點後一位）和具體建議。

要求：
- 所有建議必須使用繁體中文標準書面語，不得使用任何粵語口語（如「嘅」、「咁」、「佢」等）。
- 評分結果請以 JSON 格式輸出，格式如下：
{"accuracy":分數, "fluency":分數, "integrity":分數, "total_score":平均分, "suggestion":"建議"}
其中 accuracy、fluency、integrity 及 total_score 均須為小數點後一位的數字。`;
        } else {
            const subQs = questionInfo.subQuestions || [];
            let subPrompt = '';
            subQs.forEach((sq, i) => {
                subPrompt += `子問題${i+1}：${sq.question}\n參考答案：${sq.answer||''}\n關鍵字：${(sq.keywords||[]).join('、')}\n`;
            });
            prompt = `你是一位專業的普通話教師，請用鼓勵性語氣評分。

題目類型：半固定式看圖答問題
${subPrompt}
學生回答（逐題）：
${answerText}

請對每個子問題分別給出以下三項分數（每項0-10分，精確到小數點後一位）和具體評語：
- 內容相關性（accuracy）：是否切題，運用關鍵字。
- 完整性（completeness）：是否使用完整句子作答，避免破碎或不完整的表達。
- 語音準確度（integrity）：**請注意，你只能看到轉寫後的文字，無法聽到真實語音。因此，請根據文字中是否存在錯別字、用詞不當或不合語境的情況來推斷可能的語音錯誤（如發音近似導致的別字）。若發現此類問題，請在評語中溫和地指出，並詢問學生原本是否想表達某個特定詞語。若文字內容完全無法理解（意義不明或嚴重離題），則可能代表語音準確度極低或完全跑題，請據實給予低分。**

然後計算總分（0-10，可為各子問題的平均分，精確到小數點後一位）並給出整體建議。

要求：
- 所有評語和建議必須使用繁體中文標準書面語，不得使用任何粵語口語（如「嘅」、「咁」、「佢」等）。
- 輸出 JSON 格式：
{"sub_scores":[{"accuracy":分數, "completeness":分數, "integrity":分數, "comment":"評語"}, ...], "total_score":平均分, "suggestion":"整體建議"}
其中所有分數均須為小數點後一位的數字。`;
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
            const subScores = subCount > 0 ? question.subQuestions.map(() => ({ accuracy: 0.0, completeness: 0.0, integrity: 0.0, comment: '未使用普通話作答' })) : [];
            res.status(200).json({
                score: {
                    total_score: 0.0,
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
