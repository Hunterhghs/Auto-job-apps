import type { Page } from "@cloudflare/puppeteer";

/** Human-like typing delay range in ms per keystroke. */
const TYPE_DELAY_MIN = 40;
const TYPE_DELAY_MAX = 120;

export function jitter(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Type into an element with human-like per-keystroke delays. */
export async function humanType(
  page: Page,
  selector: string,
  text: string
): Promise<void> {
  await page.click(selector, { clickCount: 3 }); // select existing content
  for (const char of text) {
    await page.type(selector, char, {
      delay: jitter(TYPE_DELAY_MIN, TYPE_DELAY_MAX),
    });
  }
  await sleep(jitter(150, 450));
}

/**
 * Upload a resume held in memory (from R2) into a file input. Puppeteer's
 * uploadFile needs a filesystem path, which Workers lack, so we construct a
 * File in the page context and fire the change event React forms listen for.
 */
export async function uploadFileToInput(
  page: Page,
  inputSelector: string,
  bytes: ArrayBuffer,
  fileName: string,
  mimeType = "application/pdf"
): Promise<boolean> {
  const b64 = arrayBufferToBase64(bytes);
  return page.evaluate(
    (selector, data, name, mime) => {
      const input = document.querySelector(selector) as HTMLInputElement | null;
      if (!input) return false;
      const byteChars = atob(data);
      const byteArray = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteArray[i] = byteChars.charCodeAt(i);
      }
      const file = new File([byteArray], name, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    inputSelector,
    b64,
    fileName,
    mimeType
  );
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export interface FormField {
  /** CSS selector uniquely identifying the input */
  selector: string;
  label: string;
  type: "text" | "textarea" | "select" | "radio" | "checkbox" | "file";
  required: boolean;
  options?: string[];
}

/**
 * Generic form inspection: find labeled inputs on the page. Works on
 * label[for]-linked and label-wrapped inputs, which covers Ashby,
 * Greenhouse, and Lever forms.
 */
export async function inspectForm(page: Page): Promise<FormField[]> {
  return page.evaluate(() => {
    const fields: {
      selector: string;
      label: string;
      type: "text" | "textarea" | "select" | "radio" | "checkbox" | "file";
      required: boolean;
      options?: string[];
    }[] = [];

    const seen = new Set<Element>();
    const inputs = document.querySelectorAll(
      "form input, form textarea, form select"
    ) as HTMLElement[];

    let autoId = 0;
    for (const el of inputs) {
      if (seen.has(el)) continue;
      seen.add(el);

      const input = el as HTMLInputElement;
      if (input.type === "hidden" || input.type === "submit") continue;

      // Find the label: label[for], wrapping label, aria-label, or nearby text
      let labelText = "";
      if (input.id) {
        const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
        if (forLabel) labelText = forLabel.textContent ?? "";
      }
      if (!labelText) {
        const wrap = input.closest("label");
        if (wrap) labelText = wrap.textContent ?? "";
      }
      if (!labelText) labelText = input.getAttribute("aria-label") ?? "";
      if (!labelText) {
        const container = input.closest("div,fieldset");
        const lbl = container?.querySelector("label, legend, .label");
        if (lbl) labelText = lbl.textContent ?? "";
      }
      labelText = labelText.replace(/\s+/g, " ").replace(/[*✱]/g, "").trim();

      // Ensure a usable selector
      if (!input.id && !input.name) {
        input.setAttribute("data-aja", String(autoId++));
      }
      const selector = input.id
        ? `#${CSS.escape(input.id)}`
        : input.name
          ? `${input.tagName.toLowerCase()}[name="${CSS.escape(input.name)}"]`
          : `[data-aja="${input.getAttribute("data-aja")}"]`;

      const required =
        input.required ||
        input.getAttribute("aria-required") === "true" ||
        /required|\*/.test(
          input.closest("div,fieldset")?.querySelector("label")?.textContent ?? ""
        );

      let type: "text" | "textarea" | "select" | "radio" | "checkbox" | "file";
      let options: string[] | undefined;
      if (input.tagName === "TEXTAREA") type = "textarea";
      else if (input.tagName === "SELECT") {
        type = "select";
        options = [...(input as unknown as HTMLSelectElement).options]
          .map((o) => o.text.trim())
          .filter((t) => t && !/^select|^choose|^--/i.test(t));
      } else if (input.type === "radio") {
        type = "radio";
      } else if (input.type === "checkbox") type = "checkbox";
      else if (input.type === "file") type = "file";
      else type = "text";

      fields.push({ selector, label: labelText, type, required, options });
    }
    return fields;
  });
}

/** Check whether the page contains a CAPTCHA we can't get past. */
export async function hasCaptcha(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    return !!document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, [data-sitekey]'
    );
  });
}

/** Normalize a label for matching against known answers. */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[?:*✱]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
