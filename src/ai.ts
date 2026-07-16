import { profile, knownAnswers } from "./profile";

interface Env {
  AI: Ai;
  DEEPSEEK_API_KEY?: string;
}

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

const SYSTEM_PROMPT = `You are filling out job applications on behalf of a real candidate. Your job is to provide truthful, professional answers that represent the candidate accurately. The candidate is a British-American male — use standard, traditional professional language. Be concise and direct.

CRITICAL REASONING RULES:
1. FIRST, check if the profile or known answers contain an exact match for the question.
2. If no exact match, INFER a reasonable answer from the candidate's background. For example:
   - "What are your technical skills?" → list skills from the profile
   - "Why are you interested in this role?" → explain how the role fits the candidate's analytical background and market research experience
   - "Describe your experience with data analysis" → reference the candidate's published reports, BI certifications, and client engagements
   - "What is your management style?" → answer based on running a solo consultancy
3. For numeric/text fields (years of experience, degree, certifications, tools), use ONLY facts from the profile. Do not estimate numbers.
4. Be specific. "I have experience in market research" is weak. "I've published 84+ market intelligence reports and delivered 40+ client engagements" is strong.
5. If you truly CANNOT answer even with inference (e.g., the candidate has zero relevant information anywhere in the profile), reply: CANNOT_ANSWER

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
 * Answer a free-text application question using two-pass reasoning:
 * Pass 1 — attempt a confident answer from profile facts.
 * Pass 2 — if CANNOT_ANSWER, re-prompt with explicit inference instructions.
 * Returns null only when both passes fail.
 */
export async function answerQuestion(
  env: Env,
  question: string,
  jobContext: { company?: string; title: string; description?: string }
): Promise<string | null> {
  // Pass 1: direct answer from profile
  const text = await chat(env, [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Job: ${jobContext.title}${jobContext.company ? ` at ${jobContext.company}` : ""}
${jobContext.description ? `Job description (excerpt): ${jobContext.description.slice(0, 2000)}` : ""}

Application question: "${question}"

Answer in 1-3 sentences. Be specific and use facts from the profile. Plain text only.`,
    },
  ]);
  if (text && !text.includes("CANNOT_ANSWER")) return text;

  // Pass 2: reasoning — infer from the candidate's overall background
  const reasoning = await chat(env, [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `The application asks: "${question}"

This question does not have a direct answer in the profile. BUT — you MUST provide a reasonable, truthful answer by INFERRING from the candidate's background. Think step by step:
- What skills/experience does the candidate have that relate to this?
- What would a Business Analyst with a market research firm, 40+ client engagements, and data certifications reasonably say?
- If it's about tools/software, mention Excel, statistics tools, BI platforms, and AI-assisted workflows.
- If it's about motivation or goals, connect to the candidate's consulting and analytical background.
- If it's about experience level, use the candidate's actual timeline (BSBA 2024, freelancing since Sept 2024).

Provide a SPECIFIC, professional 1-3 sentence answer in first person. DO NOT say CANNOT_ANSWER unless no human could possibly infer anything.`,
    },
  ]);
  if (reasoning && !reasoning.includes("CANNOT_ANSWER")) return reasoning;

  return null;
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
  // Pass 1: direct match
  const text = await chat(env, [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Application question: "${question}"

Options:
${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}

Reply with ONLY the number of the option that is truthful for the candidate. If none fits, reply CANNOT_ANSWER.`,
    },
  ]);
  const match1 = text.match(/\d+/);
  if (match1 && !text.includes("CANNOT_ANSWER")) {
    const idx = parseInt(match1[0], 10) - 1;
    if (options[idx]) return options[idx];
  }

  // Pass 2: reasoning — infer the closest truthful option
  const reasoning = await chat(env, [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Application question: "${question}"

Options:
${options.map((o, i) => `${i + 1}. ${o}`).join("\n")}

None of these options are a perfect match. BUT — you MUST pick the CLOSEST truthful option by reasoning from the candidate's background:
- Education: BSBA Management, Magna Cum Laude, Appalachian State (2024)
- Work: Founder/CEO of H Heuristics (market research firm), 40+ Upwork engagements
- Certs: CFI BIDA, FTIP, SAS Statistical Business Analyst
- Experience: freelancing since Sept 2024 (~2 years), published 84+ reports
- Location/visa: US citizen, Chapel Hill NC, authorized to work in the US without sponsorship

Reply with ONLY the number of the best option. Do NOT say CANNOT_ANSWER.`,
    },
  ]);
  const match2 = reasoning.match(/\d+/);
  if (match2 && !reasoning.includes("CANNOT_ANSWER")) {
    const idx = parseInt(match2[0], 10) - 1;
    if (options[idx]) return options[idx];
  }

  return null;
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
