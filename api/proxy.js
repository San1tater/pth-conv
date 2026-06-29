const crypto = require('crypto');
const WebSocket = require('ws');

const APPID = process.env.XUNFEI_APPID;
const API_KEY = process.env.XUNFEI_API_KEY;
const API_SECRET = process.env.XUNFEI_API_SECRET;
const SPARK_URL = 'wss://spark-api.xf-yun.com/v4.0/chat';

/**
 * 根據語言生成評分提示詞（精簡版）
 */
function buildPrompt(questionInfo, answerText, lang) {
    const isOpen = questionInfo.type === 'open';
    const refAnswer = questionInfo.refAnswer || '';
    const keywords = (questionInfo.keywords || []).join('、');
    const subQs = questionInfo.subQuestions || [];

    // 共用核心說明（已拆分為三項獨立要求）
    const coreInstruction = {
        zh: `你收到的是語音轉寫文字，非書面文字。評分時：
- 語音準確度：根據轉寫流暢度與相關性推斷發音清晰度。同音字（如「可譽」轉為「可遇」）視為正確，不扣分。
- 嚴禁使用「寫」、「錯字」等詞語。
- 評語須用繁體中文書面語。
- 語氣須鼓勵、小學生能懂。
- 內容以參考答案為準，關鍵詞僅供參考（可能含干擾項）。`,
        en: `You receive speech-to-text, not written text. Scoring rules:
- Pronunciation accuracy: infer clarity from fluency/relevance. Homophones (e.g., "可譽"->"可遇") are correct, no deduction.
- Do NOT use "write", "spelling" etc.
- Comments must be in formal English.
- Use encouraging tone, understandable by primary students.
- Base on reference answer; keywords are for reference (may contain distractors).`
    };

    // 完整性評分標準（精簡）
    const completenessRule = {
        zh: `完整性：必須是完整句子（主謂賓齊全，複述問題主幹）。僅詞語或片語最高60分，部分句子60-90分，完整句子100分。`,
        en: `Completeness: full sentence with subject-verb-object, restating question core. Word/phrase max 60, partial 60-90, full 100.`
    };

    // 豐富度評分標準（僅開放式）
    const richnessRule = {
        zh: `豐富度（僅開放式）：綜合結構（時人地事、起承轉合）、情節擴充、詞彙多樣性、修飾語運用，四項平均。`,
        en: `Richness (only open): average of structure (time/people/place/event), plot expansion, vocabulary variety, modifier use.`
    };

    let prompt = '';

    if (isOpen) {
        const openTemplate = {
            zh: `題目：開放式看圖說故事
參考答案：${refAnswer}
關鍵字（可能含干擾項）：${keywords}
學生轉寫：${answerText}

${coreInstruction.zh}
${richnessRule.zh}

評分維度（0-10，一位小數）：
1. 內容相關性（accuracy）：緊扣主題與參考答案。
2. 豐富度（fluency）：按上述標準。
3. 語音準確度（integrity）：按上述標準。

輸出 JSON：{"accuracy":分數, "fluency":分數, "integrity":分數, "total_score":平均分, "suggestion":"建議"}`,
            en: `Open-ended story telling
Reference: ${refAnswer}
Keywords (may have distractors): ${keywords}
Transcription: ${answerText}

${coreInstruction.en}
${richnessRule.en}

Scores (0-10, 1 decimal):
1. Content relevance (accuracy): on topic and reference.
2. Richness (fluency): as above.
3. Pronunciation (integrity): as above.

Output JSON: {"accuracy":score, "fluency":score, "integrity":score, "total_score":avg, "suggestion":"advice"}`
        };
        prompt = openTemplate[lang];
    } else {
        // 半固定式
        let subPrompt = '';
        subQs.forEach((sq, i) => {
            const sqRef = sq.answer || '';
            const sqKw = (sq.keywords || []).join('、');
            if (lang === 'zh') {
                subPrompt += `子問題${i+1}：${sq.question}\n參考答案：${sqRef}\n關鍵字：${sqKw}\n`;
            } else {
                subPrompt += `SubQ${i+1}: ${sq.question}\nRef: ${sqRef}\nKeywords: ${sqKw}\n`;
            }
        });

        const fixedTemplate = {
            zh: `題目：半固定式看圖答問題
${subPrompt}
學生轉寫（逐題）：${answerText}

${coreInstruction.zh}
${completenessRule.zh}

評分（每子題0-10，一位小數）：
- 內容相關性（accuracy）：是否切題、用關鍵字（但以參考答案為準）。
- 完整性（completeness）：按上述標準。
- 語音準確度（integrity）：按上述標準。

輸出 JSON：{"sub_scores":[{"accuracy":分數, "completeness":分數, "integrity":分數, "comment":"評語"}, ...], "total_score":平均分, "suggestion":"整體建議"}`,
            en: `Fixed Q&A based on picture
${subPrompt}
Transcriptions: ${answerText}

${coreInstruction.en}
${completenessRule.en}

Scores per subQ (0-10, 1 decimal):
- Content relevance (accuracy): on topic, use keywords (but reference first).
- Completeness: as above.
- Pronunciation (integrity): as above.

Output JSON: {"sub_scores":[{"accuracy":score, "completeness":score, "integrity":score, "comment":"comment"}, ...], "total_score":avg, "suggestion":"overall"}`
        };
        prompt = fixedTemplate[lang];
    }

    return prompt;
}

/**
 * 呼叫星火大模型進行評分
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

        const prompt = buildPrompt(questionInfo, truncated, lang);
        const systemContent = lang === 'zh' ? '你是一個專業的普通話口語評測助手，嚴格按JSON格式輸出。' : 'You are a Mandarin speaking assessment assistant. Output strictly in JSON.';

        ws.on('open', () => {
            ws.send(JSON.stringify({
                header: { app_id: APPID, uid: 'student' },
                parameter: { chat: { domain: '4.0Ultra', temperature: 0.3, max_tokens: 1024, top_k: 5 } },
                payload: { message: { text: [ { role: 'system', content: systemContent }, { role: 'user', content: prompt } ] } }
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

        setTimeout(() => {
            if (!finished) {
                ws.close();
                reject(new Error('Spark 請求逾時'));
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
            const subScores = subCount > 0 ? question.subQuestions.map(() => ({ accuracy: 0.0, completeness: 0.0, integrity: 0.0, comment: useLang === 'zh' ? '未使用普通話作答' : 'Not answered in Mandarin' })) : [];
            const suggestion = useLang === 'zh' ? '檢測到英文或非中文回應，請以普通話作答。' : 'English or non-Chinese detected, please answer in Mandarin.';
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
