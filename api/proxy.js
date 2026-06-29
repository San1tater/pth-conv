const crypto = require('crypto');
const WebSocket = require('ws');

const APPID = process.env.XUNFEI_APPID;
const API_KEY = process.env.XUNFEI_API_KEY;
const API_SECRET = process.env.XUNFEI_API_SECRET;
const SPARK_URL = 'wss://spark-api.xf-yun.com/v4.0/chat';

/**
 * 生成結構化評分提示詞（含明確錨點）
 */
function buildPrompt(questionInfo, answerText, lang) {
    const isOpen = questionInfo.type === 'open';
    const refAnswer = questionInfo.refAnswer || '';
    const keywords = (questionInfo.keywords || []).join('、');
    const subQs = questionInfo.subQuestions || [];

    // ----- 核心評分規則（明確分數錨點） -----
    const scoringRules = {
        zh: `
【評分總則】
- 所有維度滿分均為 10.0 分，精確到小數點後一位。
- 輸入為語音轉寫文字，非書面文字。同音/近音字替換（如「可譽」→「可遇」）視為辨識誤差，不扣「語音準確度」分。
- 以「參考答案」為主要評分依據，關鍵詞僅供參考（可能含干擾項）。

【完整性】（僅半固定式）
- 10.0：完整複述問題主幹，主謂賓齊全，語法正確。
- 7.0-9.0：句子基本完整，但缺少主語或動詞（如「三個人」缺動詞「有」）。
- 0.0-6.0：僅給出孤立詞語或片語（如「三」、「書包」），無句子結構。
- 若回答與問題無關，給 0 分。

【豐富度】（僅開放式）
綜合以下四項，取平均：
- 結構（0-10）：有清晰開頭（時間/人物/地點）、發展、結尾（起承轉合）。
- 擴充（0-10）：在參考答案和關鍵詞基礎上加入合理細節，而非僅重複。
- 詞彙（0-10）：用詞多樣，避免重複。
- 修飾（0-10）：使用恰當形容詞（如「漂亮的」）或副詞（如「慢慢地」）。

【內容相關性】（所有題型）
- 10.0：完全切合參考答案，無遺漏。
- 7.0-9.0：基本相關，但有部分偏離或遺漏。
- 0.0-6.0：明顯偏離或僅少量相關。
- 若完全無關，給 0 分。

【語音準確度】（所有題型）
- 10.0：轉寫文字流暢、意思清楚、與問題高度相關（推斷發音清晰）。
- 7.0-9.0：大致流暢，但有少量無關或含糊處。
- 0.0-6.0：文字混亂、難以理解或離題（推斷發音問題）。
- 同音字替換不扣分。

【評語要求】
- 簡單、鼓勵、小學生能懂。
- 避免「寫」「錯字」等詞。
- 使用繁體書面語（勿用粵語口語）。

【輸出格式】
嚴格輸出 JSON，不包含任何其他文字。
`,
        en: `
[Scoring Rules]
- All dimensions max 10.0, one decimal.
- Input is speech-to-text. Homophone errors (e.g., "可遇" vs "可譽") are recognition issues, do not deduct from Pronunciation.
- Use Reference Answer as primary basis; Keywords are reference only (may contain distractors).

[Completeness] (fixed only)
- 10.0: Full sentence restating question core, subject+verb+object.
- 7.0-9.0: Mostly complete but missing subject or verb (e.g., "Three people" missing "are").
- 0.0-6.0: Only isolated words or phrases, no sentence structure.
- 0 if irrelevant.

[Richness] (open only)
Average of four:
- Structure (0-10): Clear beginning (time/person/place), development, end.
- Expansion (0-10): Adds reasonable details beyond ref/keywords.
- Vocabulary (0-10): Varied, no repetition.
- Modifiers (0-10): Uses adjectives (e.g., "beautiful") or adverbs (e.g., "slowly").

[Content Relevance] (all)
- 10.0: Fully matches reference, no omission.
- 7.0-9.0: Mostly relevant, minor deviation.
- 0.0-6.0: Clearly off-topic or little relevance.
- 0 if totally irrelevant.

[Pronunciation] (all)
- 10.0: Transcribed text fluent, clear, highly relevant (clear pronunciation inferred).
- 7.0-9.0: Mostly fluent, some vague parts.
- 0.0-6.0: Garbled, hard to understand, or off-topic (poor pronunciation inferred).
- Homophone errors do not reduce score.

[Comments]
- Simple, encouraging, child-friendly.
- Avoid "write","spelling".
- Use standard English.

[Output]
Strict JSON only, no extra text.
`
    };

    // ----- 題型專用模板 -----
    let prompt = '';
    if (isOpen) {
        const openTemplate = {
            zh: `題型：開放式看圖說故事
參考答案：${refAnswer}
關鍵字（可能含干擾項）：${keywords}
學生回答（轉寫）：${answerText}

請依上述規則評分，輸出 JSON：
{"accuracy":數值, "fluency":數值, "integrity":數值, "total_score":數值, "suggestion":"文字"}`,
            en: `Type: Open-ended Storytelling
Reference: ${refAnswer}
Keywords (may contain distractors): ${keywords}
Student response (transcribed): ${answerText}

Score per rules above, output JSON:
{"accuracy":number, "fluency":number, "integrity":number, "total_score":number, "suggestion":"text"}`
        };
        prompt = scoringRules[lang] + '\n' + openTemplate[lang];
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

對每子題依上述規則給分，輸出 JSON：
{"sub_scores":[{"accuracy":數值, "completeness":數值, "integrity":數值, "comment":"文字"}, ...], "total_score":數值, "suggestion":"文字"}`,
            en: `Type: Fixed Q&A
${subPrompt}
Student responses (transcribed, per question):
${answerText}

For each sub-question, score per rules above, output JSON:
{"sub_scores":[{"accuracy":number, "completeness":number, "integrity":number, "comment":"text"}, ...], "total_score":number, "suggestion":"text"}`
        };
        prompt = scoringRules[lang] + '\n' + fixedTemplate[lang];
    }

    return prompt;
}

/**
 * 呼叫星火大模型進行評分
 */
function scoreAnswer(questionInfo, answerText, lang) {
    return new Promise((resolve, reject) => {
        // 截斷答案防止過長（保留完整句子結構）
        let truncated = answerText;
        if (answerText.length > 300) {
            truncated = answerText.substring(0, 300) + '...(截斷)';
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
        // 系統訊息：強調 JSON 輸出
        const systemContent = lang === 'zh' 
            ? '你是評測助手。輸出必須為純 JSON，不要包含任何解釋或額外文字。' 
            : 'You are an assessment assistant. Output must be pure JSON, no explanations or extra text.';

        ws.on('open', () => {
            ws.send(JSON.stringify({
                header: { app_id: APPID, uid: 'student' },
                parameter: { chat: { domain: '4.0Ultra', temperature: 0.2, max_tokens: 800, top_k: 5 } },
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

        // 增加超時時間到 25 秒（因模型可能較慢）
        setTimeout(() => {
            if (!finished) {
                ws.close();
                reject(new Error('Spark 請求逾時 (25s)'));
            }
        }, 25000);
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

        // 檢查是否有中文字元（簡易）
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
            // 清理可能的 markdown 或額外文字
            let jsonStr = scoreRaw.trim();
            // 提取第一個 { ... } 區塊
            const match = jsonStr.match(/\{[\s\S]*\}/);
            if (match) jsonStr = match[0];
            // 嘗試解析
            scoreJSON = JSON.parse(jsonStr);
        } catch (e) {
            // 解析失敗，回傳錯誤（前端會顯示）
            scoreJSON = { error: '評分解析失敗，請重試', raw: scoreRaw };
        }
        res.status(200).json({ score: scoreJSON });
    } catch (err) {
        console.error('評分請求錯誤:', err);
        res.status(500).json({ error: err.message });
    }
};
