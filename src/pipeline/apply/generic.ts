import type { Page } from "@cloudflare/puppeteer";
import type { ApplyResult, JobRow } from "../../types";
import { profile, knownAnswers } from "../../profile";
import { answerQuestion, pickOption, coverLetter } from "../../ai";
import {
  inspectForm,
  humanType,
  uploadFileToInput,
  hasCaptcha,
  normalizeLabel,
  sleep,
  jitter,
  type FormField,
} from "./formkit";

interface ApplierEnv {
  AI: Ai;
  FILES: R2Bucket;
  CONFIG?: KVNamespace;
  DEEPSEEK_API_KEY?: string;
}

/**
 * Label-driven form filler that works across Ashby, Greenhouse, and Lever:
 * all three render single-page forms with labeled inputs. Strategy per field:
 *   1. exact/fuzzy match against known profile answers
 *   2. AI answer grounded in the profile (free text) or option picking
 *   3. if a REQUIRED field can't be answered -> abort as needs_review
 */
export async function fillAndSubmit(
  page: Page,
  env: ApplierEnv,
  job: JobRow
): Promise<ApplyResult> {
  if (await hasCaptcha(page)) {
    return { status: "needs_review", reason: "CAPTCHA present" };
  }

  let fields = await inspectForm(page);
  if (fields.length === 0) {
    // Many platforms (BambooHR, some ATS configs) hide the form behind an
    // "Apply" button. Click it first, then re-inspect.
    const clicked = await clickApplyButton(page);
    if (!clicked) {
      return { status: "needs_review", reason: "no form fields found" };
    }
    await sleep(3000);
    fields = await inspectForm(page);
    if (fields.length === 0) {
      return { status: "needs_review", reason: "no form fields after clicking apply" };
    }
  }

  return doFillAndSubmit(page, env, job, fields);
}

/** Fill all discovered fields, submit, and confirm. */
async function doFillAndSubmit(
  page: Page,
  env: ApplierEnv,
  job: JobRow,
  fields: FormField[]
): Promise<ApplyResult> {
  const known = knownAnswers(profile);
  const answers: Record<string, string> = {};
  const jobContext = {
    company: job.company ?? undefined,
    title: job.title,
  };

  for (const field of fields) {
    const label = normalizeLabel(field.label);
    if (!label && field.type !== "file") continue;

    try {
      const handled = await fillField(page, env, field, label, known, jobContext, answers);
      if (!handled && field.required) {
        return {
          status: "needs_review",
          reason: `cannot answer required field: "${field.label}"`,
          answers,
        };
      }
    } catch (err) {
      if (field.required) {
        return {
          status: "failed",
          reason: `error filling "${field.label}": ${String(err)}`,
          answers,
        };
      }
    }
    await sleep(jitter(300, 900));
  }

  // Handle email verification if detected
  const verified = await handleEmailVerification(page, env, answers);
  if (verified === "failed") {
    return { status: "needs_review", reason: "email verification required but code not received", answers };
  }

  // Submit
  const submitted = await clickSubmit(page);
  if (!submitted) {
    return { status: "needs_review", reason: "submit button not found", answers };
  }

  await sleep(5000);

  // Confirmation heuristics: URL change, success text, or form removal
  const confirmed = await page.evaluate(() => {
    const text = document.body.innerText.toLowerCase();
    return (
      /thank you|application (?:submitted|received|sent)|successfully (?:submitted|applied)|we've received/.test(
        text
      ) || !document.querySelector('form input[type="file"], form [type="submit"]')
    );
  });

  if (!confirmed) {
    // Check for validation errors still on screen
    const errorText = await page.evaluate(() => {
      const el = document.querySelector(
        '[class*="error"], [role="alert"], .field_error'
      );
      return el?.textContent?.trim().slice(0, 200) ?? null;
    });
    if (errorText) {
      return { status: "needs_review", reason: `validation error: ${errorText}`, answers };
    }
  }

  return { status: "applied", answers };
}

async function fillField(
  page: Page,
  env: ApplierEnv,
  field: FormField,
  label: string,
  known: Record<string, string>,
  jobContext: { company?: string; title: string },
  answers: Record<string, string>
): Promise<boolean> {
  switch (field.type) {
    case "file": {
      const isResume = /resume|cv/i.test(label) || label === "";
      const isCover = /cover/i.test(label);

      if (isCover && !isResume) {
        // Upload the cover letter PDF from R2
        const coverObj = await env.FILES.get("cover-letter/hunter_hughes_cover_letter.pdf");
        if (coverObj) {
          const coverBytes = await coverObj.arrayBuffer();
          const ok = await uploadFileToInput(page, field.selector, coverBytes, "Hunter_Hughes_Cover_Letter.pdf", "application/pdf");
          if (ok) {
            answers[field.label || "cover letter"] = "Hunter_Hughes_Cover_Letter.pdf";
            await sleep(jitter(1000, 2000));
          }
          return ok;
        }
        return true; // Soft skip if cover letter PDF not in R2
      }

      // Resume upload
      const resumeObj = await env.FILES.get(profile.documents.resumeR2Key);
      if (!resumeObj) throw new Error("resume missing from R2");
      const bytes = await resumeObj.arrayBuffer();
      const ok = await uploadFileToInput(
        page,
        field.selector,
        bytes,
        profile.documents.resumeFileName
      );
      if (ok) {
        answers[field.label || "resume"] = profile.documents.resumeFileName;
        await sleep(jitter(2000, 4000)); // allow client-side upload/parse
      }
      return ok;
    }

    case "text":
    case "textarea": {
      // Handle specialized input types (date, number) that browsers treat differently
      if (field.type === "text") {
        const htmlType = await page.evaluate((sel) => {
          const el = document.querySelector(sel) as HTMLInputElement | null;
          return el?.type ?? "text";
        }, field.selector);
        
        if (htmlType === "date") {
          const dateVal = matchDate(label);
          if (dateVal) {
            await page.evaluate((sel, v) => {
              const el = document.querySelector(sel) as HTMLInputElement | null;
              if (el) { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }
            }, field.selector, dateVal);
            answers[field.label] = dateVal;
            return true;
          }
        }
        
        if (htmlType === "number") {
          const numVal = matchNumber(label);
          if (numVal !== null) {
            await page.evaluate((sel, v) => {
              const el = document.querySelector(sel) as HTMLInputElement | null;
              if (el) { el.value = String(v); el.dispatchEvent(new Event("change", { bubbles: true })); }
            }, field.selector, numVal);
            answers[field.label] = String(numVal);
            return true;
          }
        }
      }

      let value = matchKnown(label, known);
      if (!value && /cover letter/i.test(label)) {
        value = await coverLetter(env, jobContext);
      }
      if (!value && field.type === "textarea") {
        value = (await answerQuestion(env, field.label, jobContext)) ?? undefined;
      }
      if (!value && field.type === "text") {
        value = (await answerQuestion(env, field.label, jobContext)) ?? undefined;
        // Sanity cap: single-line inputs shouldn't get essays
        if (value && value.length > 300) value = value.slice(0, 300);
      }
      if (!value) return false;
      await humanType(page, field.selector, value);
      answers[field.label] = value;
      return true;
    }

    case "select": {
      if (!field.options || field.options.length === 0) return false;
      const choice =
        matchOption(label, field.options, known) ??
        (await pickOption(env, field.label, field.options));
      if (!choice) return false;
      const picked = await page.evaluate(
        (selector, optionText) => {
          const sel = document.querySelector(selector) as HTMLSelectElement | null;
          if (!sel) return false;
          const opt = [...sel.options].find((o) => o.text.trim() === optionText);
          if (!opt) return false;
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        },
        field.selector,
        choice
      );
      if (picked) answers[field.label] = choice;
      return picked;
    }

    case "radio": {
      // Collect all radios in the same group with their option labels
      const options = await page.evaluate((selector) => {
        const radio = document.querySelector(selector) as HTMLInputElement | null;
        if (!radio) return [];
        const group = radio.name
          ? document.querySelectorAll(
              `input[type="radio"][name="${CSS.escape(radio.name)}"]`
            )
          : [radio];
        return [...group].map((r, i) => {
          if (!r.id) r.setAttribute("data-aja-radio", String(i));
          const lbl =
            (r.id && document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.textContent) ||
            r.closest("label")?.textContent ||
            r.value;
          return {
            text: (lbl ?? "").replace(/\s+/g, " ").trim(),
            selector: r.id
              ? `#${CSS.escape(r.id)}`
              : `[data-aja-radio="${r.getAttribute("data-aja-radio")}"]`,
          };
        });
      }, field.selector);

      if (options.length === 0) return false;
      const texts = options.map((o) => o.text);
      const choice =
        matchOption(label, texts, known) ??
        (await pickOption(env, field.label, texts));
      if (!choice) return false;
      const target = options.find((o) => o.text === choice);
      if (!target) return false;
      await page.click(target.selector);
      answers[field.label] = choice;
      return true;
    }

    case "checkbox": {
      // Only tick consent/acknowledgement boxes (GDPR, privacy policy)
      if (/agree|consent|acknowledge|privacy|gdpr|terms/i.test(label)) {
        await page.click(field.selector);
        answers[field.label] = "checked";
        return true;
      }
      return !field.required;
    }
  }
}

/** Fuzzy match a form label against known profile answers. */
function matchKnown(label: string, known: Record<string, string>): string | undefined {
  if (known[label]) return known[label];
  for (const [key, value] of Object.entries(known)) {
    if (label.includes(key) || key.includes(label)) return value;
  }
  // Structured heuristics for common phrasings
  if (/\bname\b/.test(label) && /first|given/.test(label)) return profile.name.first;
  if (/\bname\b/.test(label) && /last|family|surname/.test(label)) return profile.name.last;
  if (/^name$/.test(label) || /full name/.test(label)) return profile.name.full;
  if (/e-?mail/.test(label)) return profile.contact.email;
  if (/phone|mobile/.test(label)) return profile.contact.phone;
  if (/linkedin/.test(label)) return profile.links.linkedin || profile.links.upwork;
  if (/website|portfolio|url/.test(label)) return profile.links.website;
  if (/salary|compensation|pay/.test(label) && /hour/.test(label))
    return profile.compensation.hourlyDefaultAnswer;
  if (/salary|compensation/.test(label)) return profile.compensation.salaryDefaultAnswer;
  return undefined;
}

/** Deterministic option matching for yes/no and EEO questions. */
function matchOption(
  label: string,
  options: string[],
  _known: Record<string, string>
): string | undefined {
  const find = (pattern: RegExp) => options.find((o) => pattern.test(o.toLowerCase()));

  if (/authorized|legally.*work|work.*legally|right to work/.test(label)) {
    return find(/^yes/) ?? find(/yes/);
  }
  if (/sponsor/.test(label)) {
    // "Do you require sponsorship?" -> No
    return find(/^no\b/) ?? find(/\bno\b/);
  }
  if (/gender identity|^gender/.test(label)) return find(/^male$|^man$/);
  if (/race|ethnicit/.test(label)) return find(/white/);
  if (/hispanic|latino/.test(label)) return find(/^no\b/);
  if (/veteran/.test(label)) return find(/not a protected veteran|not.*veteran|^no\b/);
  if (/disability/.test(label)) return find(/no,? i do(?:n't| not) have|^no\b/);
  if (/sexual orientation/.test(label)) return find(/heterosexual|straight/);
  if (/pronoun/.test(label)) return find(/he\/him/);
  if (/transgender/.test(label)) return find(/^no\b/);
  if (/relocat/.test(label)) return find(/^no\b/);
  if (/remote/.test(label) && /comfortable|willing|able/.test(label)) return find(/^yes/);
  if (/18 years|over 18|legal age/.test(label)) return find(/^yes/);
  if (/gdpr|consent|agree|privacy/.test(label)) return find(/^yes|agree|accept/);
  return undefined;
}

/** Provide a date value for date input fields based on the label. */
function matchDate(label: string): string | null {
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  if (/start|available|notice/i.test(label)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 14);
    return fmt(d);
  }
  if (/graduation|grad date/i.test(label)) return "2024-05-01";
  return fmt(today);
}

/** Provide a numeric value for number inputs based on the label. */
function matchNumber(label: string): number | null {
  if (/years.*experience|experience.*years/i.test(label)) return 2;
  if (/salary|compensation/.test(label)) {
    if (/hour/i.test(label)) return 40;
    return 75000;
  }
  return null;
}

async function clickSubmit(page: Page): Promise<boolean> {
  const selector = await page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll(
        'button[type="submit"], input[type="submit"], button'
      ),
    ];
    const btn = candidates.find((b) =>
      /submit|apply|send application/i.test(b.textContent ?? (b as HTMLInputElement).value ?? "")
    );
    if (!btn) return null;
    btn.setAttribute("data-aja-submit", "1");
    return '[data-aja-submit="1"]';
  });
  if (!selector) return false;
  await page.click(selector);
  return true;
}

/** Click an "Apply" link or button when the form is hidden behind it. */
async function clickApplyButton(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll(
        'a[href], button, [role="button"]'
      ),
    ] as HTMLElement[];
    const btn = candidates.find((el) => {
      const text = (el.textContent ?? "").trim();
      return /^apply/i.test(text) || /apply for this job/i.test(text) || /apply now/i.test(text);
    });
    if (btn) {
      (btn as HTMLElement).click();
      return true;
    }
    return false;
  });
}
