import Result from "../models/Result.js";
import { Note } from "../models/note.model.js";
import { User } from "../models/user_model.js";
import groq from "../utils/groqClient.js";

const MODEL = "openai/gpt-oss-120b"; 
const CACHE_TTL_MS = 60 * 60 * 1000; 
const cache = new Map();

const httpError = (status, message) => Object.assign(new Error(message), { status });

const sendError = (res, err) => {
  if (err.status) {
    return res.status(err.status).json({ success: false, message: err.message });
  }
  console.error("Explanation error:", err);
  return res.status(500).json({ success: false, message: "Server error" });
};

// ---------- helpers ----------
const optionText = (q, key) =>
  key && q.options?.[key] ? `${key}. ${q.options[key]}` : "No answer given";

const toLevel = (score) => {
  const n = Number(score);
  if (!Number.isFinite(n)) return "low";
  if (n >= 75) return "high";
  if (n >= 50) return "medium";
  return "low";
};

const parseJson = (raw) => {
  const cleaned = String(raw || "").replace(/```json|```/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Invalid AI response");
  return JSON.parse(cleaned.slice(start, end + 1));
};

const askGroq = async (messages) => {
  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.3,
  });
  return completion.choices[0].message.content;
};

const STOP_WORDS = new Set([
  "what", "which", "that", "this", "with", "from", "have", "from", "following",
  "would", "about", "there", "their", "these", "those", "when", "where", "does",
]);

// fallback: match note titles by keywords from the question
const keywordNotes = (text, notes) => {
  const words = [
    ...new Set((String(text).toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((w) => !STOP_WORDS.has(w))),
  ];
  return notes
    .map((n) => ({
      n,
      score: words.filter((w) => n.title.toLowerCase().includes(w)).length,
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.n);
};

const formatNote = (n) => ({ _id: n._id, title: n.title, url: n.pdfUrl });

// Loads the result + question and checks the user is allowed to see it
const loadContext = async (req) => {
  const { resultId, questionIndex } = req.body;
  const idx = Number(questionIndex);
  if (!resultId || !Number.isInteger(idx) || idx < 0) {
    throw httpError(400, "resultId and questionIndex are required");
  }

  let result;
  try {
    result = await Result.findById(resultId).populate("test").lean();
  } catch {
    throw httpError(400, "Invalid result id");
  }
  if (!result || !result.test) throw httpError(404, "Result not found");

  const user = await User.findById(req.id).select("email role").lean();
  if (!user) throw httpError(401, "User not found");

  // students can only open their own results; teachers can open any
  const isOwner =
    (user.email || "").trim().toLowerCase() ===
    (result.studentEmail || "").trim().toLowerCase();
  if (user.role !== "teacher" && !isOwner) {
    throw httpError(403, "You can only view explanations for your own results");
  }

  const question = result.test.questions?.[idx];
  if (!question) throw httpError(404, "Question not found");

  return {
    question,
    idx,
    resultId: String(result._id),
    studentAnswer: result.answers?.[idx] ?? null,
  };
};

// ------------------------- EXPLAIN A WRONG ANSWER ------------------------
export const getExplanation = async (req, res) => {
  try {
    const { question, idx, resultId, studentAnswer } = await loadContext(req);

    if (studentAnswer === question.correctAnswer) {
      throw httpError(400, "This answer was correct. No explanation needed");
    }

    const notes = await Note.find()
      .select("title pdfUrl")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // 1) Teacher's custom explanation overrides the default
    const custom = (question.explanation || "").trim();
    if (custom) {
      const steps = custom
        .split(/\n+/)
        .map((s) => s.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim())
        .filter(Boolean);
      return res.status(200).json({
        success: true,
        source: "teacher",
        steps,
        confidence: "high",
        confidenceReason: "Written by your teacher",
        notes: keywordNotes(question.question, notes).map(formatNote),
        followUps: [],
      });
    }

    // 2) cached AI explanation
    const cacheKey = `${resultId}:${idx}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return res.status(200).json(hit.data);
    }

    // 3) generate with Groq
    const noteList = notes.length
      ? notes.map((n) => `- ${n._id}: ${n.title}`).join("\n")
      : "(no notes uploaded yet)";

    const prompt = `You are a patient tutor. A student answered a multiple-choice question incorrectly.

Question: ${question.question}
Options:
A. ${question.options?.A || ""}
B. ${question.options?.B || ""}
C. ${question.options?.C || ""}
D. ${question.options?.D || ""}
Correct answer: ${optionText(question, question.correctAnswer)}
Student's answer: ${optionText(question, studentAnswer)}

Available study notes (id: title):
${noteList}

Reply with ONLY valid JSON (no markdown) in exactly this format:
{
  "steps": ["..."],
  "confidence": 0,
  "confidenceReason": "...",
  "relevantNoteIds": ["..."],
  "followUps": ["..."]
}
Rules:
- "steps": 3 to 5 short steps (max 25 words each): what the question asks, why the correct answer is right, why the student's choice is wrong.
- "confidence": number 0-100, your honest confidence that the explanation is correct. Use below 50 if the question is ambiguous, the answer key might be wrong, or you are unsure.
- "confidenceReason": one short sentence.
- "relevantNoteIds": up to 3 ids from the notes list above, only if clearly relevant, otherwise [].
- "followUps": 3 short questions the student could ask next.`;

    let parsed;
    try {
      const raw = await askGroq([{ role: "user", content: prompt }]);
      parsed = parseJson(raw);
    } catch (e) {
      console.error("Explanation AI error:", e);
      throw httpError(502, "Could not generate an explanation right now. Please try again");
    }

    const steps = Array.isArray(parsed.steps)
      ? parsed.steps.map((s) => String(s).trim()).filter(Boolean).slice(0, 6)
      : [];
    if (steps.length === 0) {
      throw httpError(502, "Could not generate an explanation right now. Please try again");
    }

    // keep only note ids that really exist
    const byId = new Map(notes.map((n) => [String(n._id), n]));
    let matched = (Array.isArray(parsed.relevantNoteIds) ? parsed.relevantNoteIds : [])
      .map((id) => byId.get(String(id)))
      .filter(Boolean)
      .slice(0, 3);
    if (matched.length === 0) {
      matched = keywordNotes(`${question.question} ${steps.join(" ")}`, notes);
    }

    const data = {
      success: true,
      source: "ai",
      steps,
      confidence: toLevel(parsed.confidence),
      confidenceReason: String(parsed.confidenceReason || "").trim(),
      notes: matched.map(formatNote),
      followUps: Array.isArray(parsed.followUps)
        ? parsed.followUps.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
        : [],
    };

    cache.set(cacheKey, { data, at: Date.now() });
    return res.status(200).json(data);
  } catch (err) {
    return sendError(res, err);
  }
};

// ------------------------- FOLLOW-UP QUESTION ------------------------
export const askFollowUp = async (req, res) => {
  try {
    const { question, studentAnswer } = await loadContext(req);

    const text = String(req.body.question || "").trim().slice(0, 500);
    if (!text) throw httpError(400, "Please type your question");

    const history = (Array.isArray(req.body.history) ? req.body.history : [])
      .filter((m) => m && ["user", "assistant"].includes(m.role) && typeof m.content === "string")
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));

    const teacherNote = (question.explanation || "").trim();

    const system = `You are a patient tutor helping a student understand a mistake on a multiple-choice question.

Question: ${question.question}
Options: A. ${question.options?.A || ""} | B. ${question.options?.B || ""} | C. ${question.options?.C || ""} | D. ${question.options?.D || ""}
Correct answer: ${optionText(question, question.correctAnswer)}
Student's answer: ${optionText(question, studentAnswer)}
${teacherNote ? `Teacher's explanation: ${teacherNote}` : ""}

Answer only questions related to this question or its topic. Keep the answer under 120 words and simple.
Reply with ONLY valid JSON (no markdown): {"answer":"...","confidence":0}
"confidence" is a number 0-100 for how sure you are. If unsure, say so honestly in the answer and suggest asking the teacher.`;

    let parsed;
    try {
      const raw = await askGroq([
        { role: "system", content: system },
        ...history,
        { role: "user", content: text },
      ]);
      parsed = parseJson(raw);
    } catch (e) {
      console.error("Follow-up AI error:", e);
      throw httpError(502, "Could not answer right now. Please try again");
    }

    const answer = String(parsed.answer || "").trim();
    if (!answer) throw httpError(502, "Could not answer right now. Please try again");

    return res.status(200).json({
      success: true,
      answer,
      confidence: toLevel(parsed.confidence),
    });
  } catch (err) {
    return sendError(res, err);
  }
};