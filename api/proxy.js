const crypto = require('crypto');
const WebSocket = require('ws');

const APPID = process.env.XUNFEI_APPID;
const API_KEY = process.env.XUNFEI_API_KEY;
const API_SECRET = process.env.XUNFEI_API_SECRET;
const SPARK_URL = 'wss://spark-api.xf-yun.com/v4.0/chat';

/**
 * 生成精簡但完整的評分提示詞（根據語言）
 */
function buildPrompt(questionInfo, answerText, lang) {
    const isOpen = questionInfo.type === 'open';
    const refAnswer = questionInfo.refAnswer || '';
    const keywords = (questionInfo.keywords || []).join('、');
    const subQs = questionInfo.subQuestions || [];

    // ------ 核心評分規則（精簡版） ------
    const rules = {
        zh: `
【重要】輸入為語音轉寫文字，非書面文字。評價「語音準確度」時，根據文字流暢度與相關性推斷發音清晰度。若出現同音/近音字替換（如「可譽」→「可遇」），視為系統辨識問題，不扣分，並在評語中說明。

【完整性】只給完整句子（主謂賓齊全，複述問題主幹）給滿分；僅關鍵詞最多60分；不完整句子（缺主語或動詞）給60-90分。

【豐富度】（僅開放式）綜合評估：①結構（時人地事、起承轉合）②情節擴充（基於參考答案與關鍵字）③詞彙多樣性④恰當修飾語（形容詞/副詞）。

【評分依據】以參考答案為主要標準，關鍵詞僅供參考（可能含干擾項）。評語須簡單、鼓勵、小學生能懂，避免「寫」「錯字」等詞，使用繁體書面語（勿用粵語口語）。

【輸出格式】嚴格 JSON，分數精確到小數點後一位。
`,
        en: `
[Important] Input is speech-to-text, not handwriting. For "pronunciation accuracy", infer clarity from fluency/relevance. Homophone/near-homophone errors (e.g., "可遇" vs "可譽") are recognition issues, do not deduct, mention in comment.

[Completeness] Full marks only for complete sentences (subject+verb+object, restating question core). Keywords alone ≤60. Incomplete sentences (missing subject/verb) score 60-90.

[Richness] (open-ended only) Assess: ①structure (when/who/where/what, flow) ②plot expansion (beyond ref/keywords) ③vocabulary diversity ④appropriate modifiers (adjectives/adverbs).

[Scoring basis] Reference answer is primary; keywords are reference only (may contain distractors). Comments: simple, encouraging, child-friendly; avoid "write","spelling"; use standard English.

[Output] Strict JSON, scores to one decimal.
`
    };

    // ------ 題型專用部分 ------
    let prompt = '';
    if (isOpen) {
        const openTemplate = {
            zh: `題型：開放式看圖說故事
參考答案：${refAnswer}
關鍵字（可能含干擾項）：${keywords}
學生回答（轉寫）：${answerText}

評分維度（每項0-10）：
1. 內容相關性：是否緊扣參考答案。
2. 豐富度：依上述規則綜合給分。
3. 語音準確度：依上述規則。

輸出 JSON：{"accuracy":分數, "fluency":分數, "integrity":分數, "total_score":平均, "suggestion":"建議"}`,
            en: `Type: Open-ended (Storytelling)
Reference: ${refAnswer}
Keywords (may contain distractors): ${keywords}
Student response (transcribed): ${answerText}

Score dimensions (0-10):
1. Accuracy: relevance to reference.
2. Richness: as per rules above.
3. Pronunciation: as per rules.

Output JSON: {"accuracy":score, "fluency":score, "integrity":score, "total_score":average, "suggestion":"advice"}`
        };
        prompt = rules[lang] + '\n' + openTemplate[lang];
    } else {
        let subPrompt = '';
        subQs.forEach((sq, i) => {
            const sqRef = sq.answer || '';
            const sqKw = (sq.keywords || []).join('、');
            if (lang === 'zh') {
                subPrompt += `子問題${i+1}：${sq.question}\n參考答案：${sqRef}\n關鍵字（可能干擾）：${sqKw}\n`;
            } else {
                subPrompt += `SubQ${i+1}: ${sq.question}\nRef: ${sqRef}\nKeywords (distractors possible): ${sqKw}\n`;
            }
        });
        const fixedTemplate = {
            zh: `題型：半固定式看圖答問題
${subPrompt}
學生回答（轉寫，逐題）：
${answerText}

對每子題給分（0-10）：
- 內容相關性：是否切題（參考答案為主）。
- 完整性：依上述規則。
- 語音準確度：依上述規則。

輸出 JSON：
{"sub_scores":[{"accuracy":分數, "completeness":分數, "integrity":分數, "comment":"評語"}, ...], "total_score":平均, "suggestion":"整體建議"}`,
            en: `Type: Fixed Q&A
${subPrompt}
Student responses (transcribed, per question):
${answerText}

For each sub-question (0-10):
- Accuracy: relevance (ref answer primary).
- Completeness: as per rules.
- Pronunciation: as per rules.

Output JSON:
{"sub_scores":[{"accuracy":score, "completeness":score, "integrity":score, "comment":"comment"}, ...], "total_score":average, "suggestion":"overall"}`
        };
        prompt = rules[lang] + '\n' + fixedTemplate[lang];
    }

    return prompt;
}

/**
 * 呼叫星火大模型進行評分
 */
function scoreAnswer(questionInfo, answerText, lang) {
    return new Promise((resolve, reject) => {
        // 截斷答案防止過長
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
        const systemContent = lang === 'zh' ? '你是普通話口語評測助手，嚴格按規則輸出JSON。' : 'You are a Mandarin speaking assessment assistant. Output JSON strictly.';

        ws.on('open', () => {
            ws.send(JSON.stringify({
                header: { app_id: APPID, uid: 'student' },
                parameter: { chat: { domain: '4.0Ultra', temperature: 0.3, max_tokens: 800, top_k: 5 } },
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

        // 檢測是否有中文字元（簡單判斷）
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
