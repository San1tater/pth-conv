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
            prompt = `請對以下學生回答進行評分，以客觀語氣分析，不顯露評分者身份。

題目類型：開放式看圖說故事
主題：${questionInfo.refAnswer || ''}
關鍵字：${(questionInfo.keywords||[]).join('、')}
學生的回答（由語音識別轉寫而成）：${answerText}

請從以下三個維度分別給分（每項0-10分，精確到小數點後一位）：
1. 內容相關性（accuracy）：故事是否緊扣主題和關鍵字，敘述是否完整。
2. 豐富度（fluency）：用詞是否多樣，有沒有細節描述，情節是否豐富。
3. 語音準確度（integrity）：由於輸入是語音轉寫文字，請根據文字中的錯別字、用詞不當或不合語境來推斷可能的發音問題。如果文字內容與問題完全無關，可能是發音不準導致識別偏差，也可能是真的跑題，請在建議中客觀指出。

最後給出總分（0-10，精確到小數點後一位）和具體建議。

要求：
- 所有建議和評語必須使用小學生能聽懂的簡單詞語，不要用「豐富度」、「敘事結構」等難懂的名詞，要用「用詞夠不夠多」、「故事說得清不清楚」這樣的話。
- 所有文字必須是繁體中文標準書面語，不得使用任何粵語口語（如「嘅」、「咁」、「佢」等）。
- 評分結果請以 JSON 格式輸出，格式如下：
{"accuracy":分數, "fluency":分數, "integrity":分數, "total_score":平均分, "suggestion":"建議"}
其中 accuracy、fluency、integrity 及 total_score 均須為小數點後一位的數字。`;
        } else {
            const subQs = questionInfo.subQuestions || [];
            let subPrompt = '';
            subQs.forEach((sq, i) => {
                subPrompt += `子問題${i+1}：${sq.question}\n參考答案：${sq.answer||''}\n關鍵字：${(sq.keywords||[]).join('、')}\n`;
            });
            prompt = `請對以下學生回答進行評分，以客觀語氣分析，不顯露評分者身份。

題目類型：半固定式看圖答問題
${subPrompt}
學生的回答（由語音識別轉寫而成，逐題）：
${answerText}

請對每個子問題分別給出以下三項分數（每項0-10分，精確到小數點後一位）和具體評語：
- 內容相關性（accuracy）：是否針對問題回答，有沒有用到關鍵字。
- 完整性（completeness）：回答是否完整。必須把問題裡的關鍵詞（名詞或動詞）放進句子裡，不能只丟出一個詞。例如，若問「媽媽穿著什麼？」，只答「裙子」就不完整，要說「媽媽穿著裙子」；如果能加上「漂亮的」會更好。
- 語音準確度（integrity）：由於輸入是語音轉寫文字，請根據文字中的錯別字、用詞不當或不合語境來推斷可能的發音問題。如果文字內容與問題完全無關，可能是發音不準導致識別偏差，也可能是真的跑題，請在評語中客觀指出。

然後計算總分（0-10，可為各子問題的平均分，精確到小數點後一位）並給出整體建議。

要求：
- 所有評語和建議必須使用小學生能聽懂的簡單詞語，不要用「完整性」、「語音準確度」等難懂的名詞，要用「回答得完不完全」、「有沒有說清楚」這樣的話。
- 所有文字必須是繁體中文標準書面語，不得使用任何粵語口語（如「嘅」、「咁」、「佢」等）。
- 輸出 JSON 格式：
{"sub_scores":[{"accuracy":分數, "completeness":分數, "integrity":分數, "comment":"評語"}, ...], "total_score":平均分, "suggestion":"整體建議"}
其中所有分數均須為小數點後一位的數字。`;
        }

        ws.on('open', () => {
            ws.send(JSON.stringify({
                header: { app_id: APPID, uid: 'student' },
                parameter: { chat: { domain: '4.0Ultra', temperature: 0.3, max_tokens: 1024, top_k: 5 } },
                payload: { message: { text: [ { role: 'system', content: '必須使用繁體中文標準書面語。' }, { role: 'user', content: prompt } ] } }
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
