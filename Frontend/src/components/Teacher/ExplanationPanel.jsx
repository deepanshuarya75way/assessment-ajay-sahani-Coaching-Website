import React, { useState } from "react";
import axios from "axios";
import { toast } from "react-toastify";
import {
  Lightbulb,
  BookOpen,
  Send,
  Loader2,
  ExternalLink,
  GraduationCap,
  AlertTriangle,
} from "lucide-react";
import { EXPLAIN_API_END_POINT } from "../../utils/constants";

const CONFIDENCE = {
  high: {
    label: "High confidence",
    bars: 3,
    bar: "bg-green-500",
    text: "text-green-700 dark:text-green-400",
  },
  medium: {
    label: "Medium confidence",
    bars: 2,
    bar: "bg-yellow-500",
    text: "text-yellow-700 dark:text-yellow-400",
  },
  low: {
    label: "Low confidence",
    bars: 1,
    bar: "bg-red-500",
    text: "text-red-700 dark:text-red-400",
  },
};

function ConfidenceBadge({ level }) {
  const c = CONFIDENCE[level] || CONFIDENCE.low;
  return (
    <span className={`inline-flex items-center gap-2 text-xs font-semibold ${c.text}`}>
      <span className="flex items-end gap-0.5">
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className={`w-1.5 rounded-sm ${i <= c.bars ? c.bar : "bg-gray-300 dark:bg-gray-600"}`}
            style={{ height: 6 + i * 4 }}
          />
        ))}
      </span>
      {c.label}
    </span>
  );
}

export default function ExplanationPanel({ resultId, questionIndex }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  const [followUp, setFollowUp] = useState("");
  const [asking, setAsking] = useState(false);
  const [chat, setChat] = useState([]); // { role: "user" | "assistant", content, confidence? }

  const loadExplanation = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (data || loading) return;

    try {
      setLoading(true);
      setError("");
      const res = await axios.post(
        EXPLAIN_API_END_POINT,
        { resultId, questionIndex },
        { withCredentials: true }
      );
      setData(res.data);
    } catch (e) {
      setError(e.response?.data?.message || "Could not load the explanation");
    } finally {
      setLoading(false);
    }
  };

  const sendFollowUp = async (text) => {
    const q = (text ?? followUp).trim();
    if (!q || asking) return;

    const history = chat.map(({ role, content }) => ({ role, content }));
    setChat((prev) => [...prev, { role: "user", content: q }]);
    setFollowUp("");

    try {
      setAsking(true);
      const res = await axios.post(
        `${EXPLAIN_API_END_POINT}/follow-up`,
        { resultId, questionIndex, question: q, history },
        { withCredentials: true }
      );
      setChat((prev) => [
        ...prev,
        { role: "assistant", content: res.data.answer, confidence: res.data.confidence },
      ]);
    } catch (e) {
      toast.error(e.response?.data?.message || "Could not get an answer");
    } finally {
      setAsking(false);
    }
  };

  const isLow = data?.confidence === "low";

  return (
    <div className="mt-6">
      <button
        onClick={loadExplanation}
        className="flex items-center gap-2 text-sm font-semibold text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-500/10 hover:bg-blue-100 dark:hover:bg-blue-500/20 px-4 py-2 rounded-xl transition"
      >
        <Lightbulb size={16} />
        {open ? "Hide explanation" : "Why was this wrong?"}
      </button>

      {open && (
        <div className="mt-4 border border-blue-200 dark:border-blue-500/30 bg-blue-50/50 dark:bg-blue-500/5 rounded-2xl p-5 space-y-4">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <Loader2 size={16} className="animate-spin" /> Preparing your explanation…
            </div>
          )}

          {error && !loading && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          {data && (
            <>
              {/* Header: source + confidence */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300">
                  {data.source === "teacher" ? (
                    <>
                      <GraduationCap size={14} /> Explanation from your teacher
                    </>
                  ) : (
                    <>
                      <Lightbulb size={14} /> AI explanation
                    </>
                  )}
                </span>
                <ConfidenceBadge level={data.confidence} />
              </div>

              {data.confidenceReason && (
                <p className="text-xs text-gray-500 dark:text-gray-400 -mt-2">
                  {data.confidenceReason}
                </p>
              )}

              {isLow && (
                <div className="flex gap-2 text-sm text-red-800 dark:text-red-300 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-xl p-3">
                  <AlertTriangle size={16} className="shrink-0 mt-0.5" />
                  <span>
                    I'm not fully sure about this one. Please double-check with your teacher
                    or ask a follow-up question below.
                  </span>
                </div>
              )}

              {/* Steps */}
              <ol className="space-y-2">
                {data.steps.map((step, i) => (
                  <li key={i} className="flex gap-3 text-sm text-gray-800 dark:text-gray-200">
                    <span className="shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-xs font-semibold flex items-center justify-center">
                      {i + 1}
                    </span>
                    <span className="pt-0.5 leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>

              {/* Recommended notes */}
              <div>
                <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300 mb-2">
                  <BookOpen size={14} /> Recommended material to review
                </p>
                {data.notes.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {data.notes.map((n) => (
                      <a
                        key={n._id}
                        href={n.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-700 dark:text-blue-300 bg-white dark:bg-gray-900 border border-blue-200 dark:border-blue-500/30 hover:border-blue-400 px-3 py-1.5 rounded-lg transition"
                      >
                        {n.title} <ExternalLink size={12} />
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    No matching notes yet. Check the Notes page or ask your teacher.
                  </p>
                )}
              </div>

              {/* Suggested follow-ups */}
              {data.followUps?.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-gray-600 dark:text-gray-300 mb-2">
                    {isLow ? "Try asking:" : "You could also ask:"}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {data.followUps.map((f, i) => (
                      <button
                        key={i}
                        onClick={() => sendFollowUp(f)}
                        disabled={asking}
                        className="text-xs text-left text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 hover:border-blue-400 px-3 py-1.5 rounded-lg transition disabled:opacity-50"
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Follow-up chat */}
              {chat.length > 0 && (
                <div className="space-y-2">
                  {chat.map((m, i) => (
                    <div
                      key={i}
                      className={`text-sm rounded-xl px-3 py-2 max-w-[90%] ${
                        m.role === "user"
                          ? "ml-auto bg-blue-600 text-white"
                          : "bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200"
                      }`}
                    >
                      <p className="leading-relaxed whitespace-pre-wrap">{m.content}</p>
                      {m.role === "assistant" && m.confidence && (
                        <div className="mt-1">
                          <ConfidenceBadge level={m.confidence} />
                        </div>
                      )}
                    </div>
                  ))}
                  {asking && (
                    <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                      <Loader2 size={14} className="animate-spin" /> Thinking…
                    </div>
                  )}
                </div>
              )}

              {/* Follow-up input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={followUp}
                  maxLength={500}
                  onChange={(e) => setFollowUp(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && sendFollowUp()}
                  placeholder="Ask a follow-up question…"
                  className="flex-1 text-sm rounded-xl border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-900 text-black dark:text-white px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-400"
                />
                <button
                  onClick={() => sendFollowUp()}
                  disabled={asking || !followUp.trim()}
                  className="px-3 rounded-xl bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition"
                  aria-label="Send follow-up question"
                >
                  <Send size={16} />
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}