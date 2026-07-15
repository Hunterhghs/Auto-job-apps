import { profile, knownAnswers } from "./profile";

interface Env {
  AI: Ai;
  DEEPSEEK_API_KEY?: string;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const SYSTEM_PROMPT = `You are filling out job applications on behalf of this candidate. Answer questions truthfully based on the profile below, in the candidate's first-person voice. Be concise and professional. Never invent credentials, employers, or dates. If a question cannot be answered from the profile, reply with exactly: CANNOT_ANSWER

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

KNOWN ANSWERS:
${JSON.stringify(knownAnswers(profile), null, 2)}`;

/** Call DeepSeek (primary) or Workers AI (fallback). Returns trimmed text. */
async function chat(env: Env, messages: ChatMessage[]): Promise<string> {
  if (env.DEEPSEEK_API_KEY) {
    try {
      const res = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          messages,
          temperature: 0.4,
          max_tokens: 600,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          choices: { message: { content: string } }[];
        };
        const text = data.choices[0]?.message?.content?.trim();
        if (text) return text;
      } else {
        console.log(
          JSON.stringify({ event: "deepseek_error", status: res.status })
        );
      }
    } catch (err) {
      console.log(JSON.stringify({ event: "deepseek_fetch_failed", err: String(err) }));
    }
  }

  // Fallback: Workers AI
  const result = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
    messages,
    max_tokens: 600,
  })) as { response?: string };
  return (result.response ?? "").trim();
}

/**
 * Answer a free-text application question. Returns null when the model
 * cannot answer confidently (job goes to needs_review instead).
 */
export async function answerQuestion(
  env: Env,
  question: string,
  jobContext: { company?: string; title: string; description?: string }
): Promise<string | null> {
  const text = await chat(env, [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Job: ${jobContext.title}${jobContext.company ? ` at ${jobContext.company}` : ""}
${jobContext.description ? `Job description (excerpt): ${jobContext.description.slice(0, 2000)}` : ""}

Application question: "${question}"

Answer in 1-3 sentences unless the question clearly requires more. Plain text only.`,
    },
  ]);
  if (!text || text.includes("CANNOT_ANSWER")) return null;
  return text;
}

/**
 * Pick the best option for a select/radio question. Returns null when no
 * option is a confident match.
 */
export async function pickOption(
  env: Env,
  question: string,
  options: string[]
): Promise<string | null> {
  const text = await chat(env, [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Application question: "${question}"

Options:
${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}

Reply with ONLY the number of the option that is truthful for the candidate. If none fits confidently, reply CANNOT_ANSWER.`,
    },
  ]);
  const match = text.match(/\d+/);
  if (!match || text.includes("CANNOT_ANSWER")) return null;
  const idx = parseInt(match[0], 10) - 1;
  return options[idx] ?? null;
}

/** Generate a short tailored cover letter for a job. */
export async function coverLetter(
  env: Env,
  jobContext: { company?: string; title: string; description?: string }
): Promise<string> {
  return chat(env, [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Write a concise cover letter (150-220 words, 3 short paragraphs, no header/address block, sign off as Hunter Hughes) for this job:

Title: ${jobContext.title}
${jobContext.company ? `Company: ${jobContext.company}` : ""}
${jobContext.description ? `Description (excerpt): ${jobContext.description.slice(0, 2500)}` : ""}

Emphasize the most relevant parts of the candidate's background for THIS role. Plain text only.`,
    },
  ]);
}
