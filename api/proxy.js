const crypto = require('crypto');
const WebSocket = require('ws');

const APPID = process.env.XUNFEI_APPID;
const API_KEY = process.env.XUNFEI_API_KEY;
const API_SECRET = process.env.XUNFEI_API_SECRET;
const SPARK_URL = 'wss://spark-api.xf-yun.com/v4.0/chat';

/**
 * 根據語言生成評分提示詞（Prompt）
 * @param {Object} questionInfo - 題目資訊
 * @param {string} answerText - 學生回答（語音轉寫文字）
 * @param {string} lang - 'zh' 或 'en'
 * @returns {string} 完整的系統提示 + 使用者提問
 */
function buildPrompt(questionInfo, answerText, lang) {
    const isOpen = questionInfo.type === 'open';
    const refAnswer = questionInfo.refAnswer || '';
    const keywords = (questionInfo.keywords || []).join('、');
    const subQs = questionInfo.subQuestions || [];

    // 通用說明（中英文版本）
    const commonIntro = {
        zh: `請對以下學生回答進行評分，以客觀語氣分析，不顯露評分者身份。

重要說明：
1. 你收到的「學生回答」是**語音識別系統將學生的語音轉寫成的文字**，不是學生寫下來的文字。因此，評價「語音準確度」時，請根據這段轉寫文字是否流暢、意思是否清楚、是否與問題相關來推斷學生的發音是否清晰。如果文字流暢且切題，說明發音清楚，給高分；如果文字混亂、難以理解或與問題無關，說明可能有發音問題導致識別偏差，應給低分。

2. 特別注意「同音字／近音字」的識別誤差：當轉寫文字與參考答案相比，僅出現**字音完全相同或極度相似（如聲調不同但聲母韻母相同）的字詞替換**（例如「可譽小學」被轉寫為「可遇小學」），這種情況通常是由語音識別系統的模型偏差造成，**並非學生的發音錯誤**。此時，你應將該詞視為「正確」，不應扣減「語音準確度」分數，也不應在評語中說學生發錯音，而應指出「這可能是語音辨識的結果，您的發音是正確的」。

3. 請不要以「寫字」的角度來評論，**絕對不要使用「寫」、「寫字」、「寫對」、「寫錯」等詞語**，也不要指出具體的「錯別字」，因為那是轉寫系統的結果，不代表學生寫錯字。

4. 評分時請以**參考答案**為主要依據，關鍵詞僅作為參考。注意：關鍵詞中可能包含「干擾項」（即與正確答案無關或錯誤的詞彙），請勿機械比對關鍵詞，應以內容是否切合參考答案為主。

5. 所有評語和建議必須使用小學生能聽懂的簡單詞語，語氣要鼓勵和幫助，重點是告訴學生怎樣可以說得更好。

6. 所有文字必須是繁體中文標準書面語，不得使用任何粵語口語（如「嘅」、「咁」、「佢」等）。

7. 關於「完整性」的評分標準（極其重要，必須嚴格執行）：
   完整性評估的是學生回答是否以**完整句子**的形式呈現。一個完整句子必須包含明確的主語、謂語（動詞）和必要的賓語或補語，且能獨立回答所問問題。評分時，請依據以下規則：
   - 滿分（100分）：回答是一個語法完整、通順的陳述句，且完整複述了問題中的關鍵主幹（例如，問題問「圖畫中有多少個人？」，完整回答應為「圖畫中有X個人。」或「圖畫裡有X個人。」，不能只說「X個」或「X個人」）。必須包含主語、動詞和數量／名詞。
   - 部分分數（60-90分）：回答雖然是句子，但缺乏部分主幹（例如缺少主語或動詞），或者意思基本清楚但句子結構不完整。例如回答「三個人」缺少動詞「有」，應給予70分左右。
   - 最低分（0-60分）：回答僅為孤立詞語或片語（如「三」、「三個」、「書包」），沒有任何句子結構。此類回答最多給60分，通常應在20-50分之間，取決於詞語與問題的相關性。
   - 若回答與問題完全無關或為無意義音節，給0分。
   請嚴格按照上述標準為每個子問題的「完整性」打分，並在評語中準確描述學生的表現（例如「你只說了一個詞，沒有說成完整的句子」），不得在評語中對不完整的回答使用「句子完整」或類似表述。

8. 對於「內容相關性」和「語音準確度」，請按照各自標準獨立評分，不受完整性評分影響。`,
        en: `Please rate the following student response objectively, without revealing your identity as a rater.

Important:
1. The "student response" you receive is **speech-to-text transcription of the student's spoken answer**, not written text. Therefore, when evaluating "pronunciation accuracy", please infer from whether the transcribed text is fluent, clear, and relevant to the question. If the text is fluent and on-topic, the pronunciation was likely clear (give high score). If the text is garbled, hard to understand, or off-topic, it suggests possible pronunciation issues leading to recognition errors (give low score).

2. Pay special attention to **homophone/near-homophone recognition errors**: If the transcribed text differs from the reference answer only by words that sound **identical or extremely similar** (e.g., same initial and final but different tone), such as "可譽小學" transcribed as "可遇小學", this is usually a system bias of the speech recognizer, **not the student's mispronunciation**. In such cases, you should treat the word as "correct", do not deduct "pronunciation accuracy" score, and do not say the student mispronounced. Instead, point out that "this may be a speech recognition issue; your pronunciation is correct".

3. Do NOT comment from a "writing" perspective. **Absolutely avoid words like "write", "spell", "spelling mistake", "typo"**, because the input is a transcription, not student handwriting.

4. Base your scoring primarily on the **reference answer**. Keywords are for reference only – note that they may contain "distractors" (irrelevant or incorrect terms). Do not mechanically match keywords; focus on whether the content aligns with the reference answer.

5. All comments and suggestions should be in simple language that primary school students can understand, using an encouraging and helpful tone. Tell the student how they can improve.

6. All text must be in standard English (no slang or informal expressions).

7. Regarding the "completeness" scoring criteria (extremely important, must be strictly enforced):
   Completeness evaluates whether the student's response is presented as a **complete sentence**. A complete sentence must contain a clear subject, predicate (verb), and necessary object or complement, and must independently answer the question. Please use the following rules:
   - Full marks (100): The response is a grammatically complete and fluent declarative sentence that fully restates the key structure of the question (e.g., if the question is "How many people are in the picture?", a complete answer should be "There are X people in the picture." or "In the picture there are X people." Simply saying "X" or "X people" is not complete). Must include subject, verb, and quantity/noun.
   - Partial score (60-90): The response is a sentence but lacks some part of the structure (e.g., missing subject or verb), or the meaning is basically clear but the sentence is incomplete. For example, "Three people" is missing the verb "are/have", so around 70 points.
   - Lowest score (0-60): The response is only an isolated word or phrase (e.g., "three", "three pieces", "schoolbag") with no sentence structure. Such responses get at most 60 points, usually between 20-50 depending on relevance.
   - If the response is completely irrelevant or meaningless, give 0 points.
   Apply these standards strictly to each sub-question's "completeness" score, and in the comment accurately describe the student's performance (e.g., "You only said a word, not a complete sentence"), and do NOT use phrases like "complete sentence" for incomplete answers.

8. For "content relevance" and "pronunciation accuracy", score independently according to their own standards, unaffected by the completeness score.`
    };

    let prompt = '';

    if (isOpen) {
        // 開放式題型
        const openTemplate = {
            zh: `題目類型：開放式看圖說故事
主題（參考答案）：${refAnswer}
關鍵字（可能含干擾項）：${keywords}
學生回答（轉寫文字）：${answerText}

請從以下三個維度分別給分（每項0-10分，精確到小數點後一位）：
1. 內容相關性（accuracy）：故事是否緊扣主題和參考答案，敘述是否完整。
2. 豐富度（fluency）：用詞是否多樣，有沒有細節描述，情節是否豐富。
3. 語音準確度（integrity）：根據轉寫文字的流暢度和與問題的相關性來推斷發音清晰度。**若出現同音字／近音字替換（如上述說明），請視為正確，不扣分。**

最後給出總分（0-10，精確到小數點後一位）和具體建議。

評分結果請以 JSON 格式輸出，格式如下：
{"accuracy":分數, "fluency":分數, "integrity":分數, "total_score":平均分, "suggestion":"建議"}
其中 accuracy、fluency、integrity 及 total_score 均須為小數點後一位的數字。`,
            en: `Question type: Open-ended (Picture Storytelling)
Theme (Reference Answer): ${refAnswer}
Keywords (may contain distractors): ${keywords}
Student response (transcribed text): ${answerText}

Please score from the following three dimensions (each 0-10, one decimal place):
1. Content relevance (accuracy): Does the story stay on topic and align with the reference answer? Is it complete?
2. Richness (fluency): Are words varied? Are there details and a rich plot?
3. Pronunciation accuracy (integrity): Based on fluency and relevance of the transcribed text, infer clarity of speech. **If homophone/near-homophone substitutions occur (as described above), treat them as correct and do not deduct points.**

Give a total score (0-10, one decimal) and specific suggestions.

Output strictly in JSON format:
{"accuracy":score, "fluency":score, "integrity":score, "total_score":average, "suggestion":"advice"}
All scores must be numbers with one decimal place.`
        };
        prompt = commonIntro[lang] + '\n' + openTemplate[lang];
    } else {
        // 半固定式題型
        let subPrompt = '';
        subQs.forEach((sq, i) => {
            const sqRef = sq.answer || '';
            const sqKw = (sq.keywords || []).join('、');
            if (lang === 'zh') {
                subPrompt += `子問題${i+1}：${sq.question}\n參考答案：${sqRef}\n關鍵字（可能含干擾項）：${sqKw}\n`;
            } else {
                subPrompt += `Sub-question ${i+1}: ${sq.question}\nReference answer: ${sqRef}\nKeywords (may contain distractors): ${sqKw}\n`;
            }
        });
        const fixedTemplate = {
            zh: `題目類型：半固定式看圖答問題
${subPrompt}
學生回答（轉寫文字，逐題）：
${answerText}

請對每個子問題分別給出以下三項分數（每項0-10分，精確到小數點後一位）和具體評語：
- 內容相關性（accuracy）：是否針對問題回答，有沒有用到關鍵字（但請以參考答案為主要判斷依據）。
- 完整性（completeness）：**嚴格按照通用說明第7點評分**。必須檢查回答是否為完整句子，是否包含問題的主要名詞和動詞，並能獨立回答所問。只給一個詞或片語的回答，即使意思正確，也不能給滿分。請根據此標準逐題評估，並在評語中明確指出是「完整句子」還是「只說了詞語」。
- 語音準確度（integrity）：根據轉寫文字的流暢度和與問題的相關性來推斷發音清晰度。**若出現同音字／近音字替換（如上述說明），請視為正確，不扣分。**

然後計算總分（0-10，可為各子問題的平均分，精確到小數點後一位）並給出整體建議。

輸出 JSON 格式：
{"sub_scores":[{"accuracy":分數, "completeness":分數, "integrity":分數, "comment":"評語"}, ...], "total_score":平均分, "suggestion":"整體建議"}
其中所有分數均須為小數點後一位的數字。`,
            en: `Question type: Fixed (Q&A based on picture)
${subPrompt}
Student response (transcribed text, per question):
${answerText}

For each sub-question, give three scores (0-10, one decimal) and a comment:
- Content relevance (accuracy): Does it answer the question? Does it use keywords? (But use the reference answer as the primary judge.)
- Completeness: **Strictly follow general instruction point 7.** Check whether the response is a complete sentence, including the main nouns and verbs from the question, and can independently answer the question. Responses that are only a word or phrase, even if correct in meaning, cannot receive full marks. Evaluate each question accordingly and clearly state in the comment whether it is a "complete sentence" or "only a word/phrase".
- Pronunciation accuracy (integrity): Infer clarity from fluency and relevance of the transcribed text. **If homophone/near-homophone substitutions occur (as described above), treat them as correct and do not deduct points.**

Then give an overall total score (0-10, one decimal) and overall suggestion.

Output JSON format:
{"sub_scores":[{"accuracy":score, "completeness":score, "integrity":score, "comment":"comment"}, ...], "total_score":average, "suggestion":"overall advice"}
All scores must be numbers with one decimal place.`
        };
        prompt = commonIntro[lang] + '\n' + fixedTemplate[lang];
    }

    return prompt;
}

/**
 * 呼叫星火大模型進行評分
 */
function scoreAnswer(questionInfo, answerText, lang) {
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

        const prompt = buildPrompt(questionInfo, answerText, lang);

        // 系統訊息（依語言）
        const systemContent = lang === 'zh' ? '你是一個專業的普通話口語評測助手，請嚴格按照要求輸出 JSON。' : 'You are a professional Mandarin speaking assessment assistant. Output strictly in JSON as required.';

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

        // 語言預設為 zh
        const useLang = (lang === 'en') ? 'en' : 'zh';

        // 檢測是否包含中文字元（簡單判斷）
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
