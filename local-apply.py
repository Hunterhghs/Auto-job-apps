#!/usr/bin/env python3
"""
Local Auto-Apply — opens real browser windows, auto-fills job applications,
stops before submitting so you can review and click submit manually.

Usage:
  python3 local-apply.py                          # find and apply to analyst jobs
  python3 local-apply.py --url JOB_URL            # apply to a specific job
  python3 local-apply.py --review-only            # review applications before submit
"""

import sys, json, re, time, random, os, argparse
from pathlib import Path
from playwright.sync_api import sync_playwright, Page, Browser

# ── Hunter's Profile ──────────────────────────────────────────────────

PROFILE = {
    "name": {"full": "Hunter Hughes", "first": "Hunter", "last": "Hughes"},
    "contact": {
        "email": "hunterhughesr@outlook.com",
        "phone": "(919) 360-3499",
        "location": "Chapel Hill, NC, United States",
        "city": "Chapel Hill",
    },
    "links": {
        "website": "https://www.hheuristics.com",
        "upwork": "https://www.upwork.com/freelancers/hunterhughes",
        "linkedin": "",
    },
    "compensation": {
        "salaryDefaultAnswer": "$65,000 - $85,000, flexible depending on the full compensation package",
        "hourlyDefaultAnswer": "$35-50/hr depending on scope, flexible",
    },
    "preferences": {
        "noticePeriod": "Available immediately",
        "howDidYouHear": "Job board",
    },
    "current": {
        "company": "H Heuristics",
        "title": "Business Analyst | Founder & CEO",
    },
}

RESUME_PATH = str(Path(__file__).parent / "profile" / "Hunter_Hughes_Resume.pdf")
COVER_LETTER_PATH = None  # Will be generated if needed

# ── Known Answer Mappings ─────────────────────────────────────────────

KNOWN_ANSWERS = {
    "full name": PROFILE["name"]["full"],
    "first name": PROFILE["name"]["first"],
    "last name": PROFILE["name"]["last"],
    "email": PROFILE["contact"]["email"],
    "email address": PROFILE["contact"]["email"],
    "phone": PROFILE["contact"]["phone"],
    "phone number": PROFILE["contact"]["phone"],
    "mobile number": PROFILE["contact"]["phone"],
    "location": PROFILE["contact"]["location"],
    "current location": PROFILE["contact"]["location"],
    "city": PROFILE["contact"]["city"],
    "current company": PROFILE["current"]["company"],
    "current employer": PROFILE["current"]["company"],
    "current position": PROFILE["current"]["title"],
    "current title": PROFILE["current"]["title"],
    "current job title": "Business Analyst",
    "website": PROFILE["links"]["website"],
    "portfolio": PROFILE["links"]["website"],
    "personal website": PROFILE["links"]["website"],
    "linkedin profile": PROFILE["links"]["upwork"],
    "salary expectations": PROFILE["compensation"]["salaryDefaultAnswer"],
    "expected salary": PROFILE["compensation"]["salaryDefaultAnswer"],
    "desired salary": PROFILE["compensation"]["salaryDefaultAnswer"],
    "hourly rate": PROFILE["compensation"]["hourlyDefaultAnswer"],
    "notice period": PROFILE["preferences"]["noticePeriod"],
    "when can you start": PROFILE["preferences"]["noticePeriod"],
    "available to start": PROFILE["preferences"]["noticePeriod"],
    "how did you hear about this job": PROFILE["preferences"]["howDidYouHear"],
    "how did you hear about us": PROFILE["preferences"]["howDidYouHear"],
}

# ── Label Matching ────────────────────────────────────────────────────

def match_known(label: str) -> str | None:
    """Fuzzy match a form label against known profile answers."""
    label_lower = label.lower().strip().rstrip("*✱?:")
    
    if label_lower in KNOWN_ANSWERS:
        return KNOWN_ANSWERS[label_lower]
    
    for key, value in KNOWN_ANSWERS.items():
        if key in label_lower or label_lower in key:
            return value
    
    # Structured heuristics
    if re.search(r'\bname\b', label_lower):
        if re.search(r'first|given', label_lower):
            return PROFILE["name"]["first"]
        if re.search(r'last|family|surname', label_lower):
            return PROFILE["name"]["last"]
        return PROFILE["name"]["full"]
    
    if re.search(r'e-?mail', label_lower):
        return PROFILE["contact"]["email"]
    if re.search(r'phone|mobile', label_lower):
        return PROFILE["contact"]["phone"]
    if re.search(r'linkedin', label_lower):
        return PROFILE["links"]["upwork"]
    if re.search(r'website|portfolio|url', label_lower):
        return PROFILE["links"]["website"]
    if re.search(r'salary|compensation|pay', label_lower):
        if 'hour' in label_lower:
            return PROFILE["compensation"]["hourlyDefaultAnswer"]
        return PROFILE["compensation"]["salaryDefaultAnswer"]
    
    return None

def match_option(label: str, options: list[str]) -> str | None:
    """Deterministic matching for yes/no, EEO, and authorization questions."""
    
    def find(pattern):
        for o in options:
            if re.search(pattern, o, re.IGNORECASE):
                return o
        return None
    
    label_lower = label.lower()
    
    if re.search(r'authorized|legally.*work|work.*legally|right to work', label_lower):
        return find(r'^yes') or find(r'yes')
    if re.search(r'sponsor', label_lower):
        return find(r'^no\b') or find(r'\bno\b')
    if re.search(r'gender identity|^gender', label_lower):
        return find(r'^male$|^man$')
    if re.search(r'race|ethnicit', label_lower):
        return find(r'white')
    if re.search(r'hispanic|latino', label_lower):
        return find(r'^no\b')
    if re.search(r'veteran', label_lower):
        return find(r'not a protected veteran|not.*veteran|^no\b')
    if re.search(r'disability', label_lower):
        return find(r'no,? i do(?:n\'t| not) have|^no\b')
    if re.search(r'sexual orientation', label_lower):
        return find(r'heterosexual|straight')
    if re.search(r'pronoun', label_lower):
        return find(r'he/him')
    if re.search(r'relocat', label_lower):
        return find(r'^no\b')
    if re.search(r'remote', label_lower) and re.search(r'comfortable|willing|able', label_lower):
        return find(r'^yes')
    if re.search(r'18 years|over 18|legal age', label_lower):
        return find(r'^yes')
    if re.search(r'gdpr|consent|agree|privacy', label_lower):
        return find(r'^yes|agree|accept')
    
    return None

# ── Form Inspection ───────────────────────────────────────────────────

def inspect_form(page: Page) -> list[dict]:
    """Find all labeled form inputs on the page."""
    return page.evaluate("""() => {
        const fields = [];
        const seen = new Set();
        const inputs = document.querySelectorAll(
            "form input, form textarea, form select, input:not([type='hidden']):not([type='submit']), textarea, select"
        );
        
        let autoId = 0;
        for (const el of inputs) {
            if (seen.has(el)) continue;
            seen.add(el);
            
            const input = el;
            if (input.type === 'hidden' || input.type === 'submit') continue;
            
            let labelText = '';
            if (input.id) {
                const forLabel = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
                if (forLabel) labelText = forLabel.textContent || '';
            }
            if (!labelText) {
                const wrap = input.closest('label');
                if (wrap) labelText = wrap.textContent || '';
            }
            if (!labelText) labelText = input.getAttribute('aria-label') || '';
            if (!labelText) {
                const container = input.closest('div,fieldset');
                const lbl = container?.querySelector('label, legend, .label');
                if (lbl) labelText = lbl.textContent || '';
            }
            labelText = labelText.replace(/\\s+/g, ' ').replace(/[*✱]/g, '').trim();
            
            if (!input.id && !input.name) {
                input.setAttribute('data-local-aja', String(autoId++));
            }
            const selector = input.id
                ? `#${CSS.escape(input.id)}`
                : input.name
                    ? `${input.tagName.toLowerCase()}[name="${CSS.escape(input.name)}"]`
                    : `[data-local-aja="${input.getAttribute('data-local-aja')}"]`;
            
            let type = 'text';
            let options = undefined;
            if (input.tagName === 'TEXTAREA') type = 'textarea';
            else if (input.tagName === 'SELECT') {
                type = 'select';
                options = [...input.options].map(o => o.text.trim()).filter(t => t && !/^select|^choose|^--/i.test(t));
            } else if (input.type === 'radio') type = 'radio';
            else if (input.type === 'checkbox') type = 'checkbox';
            else if (input.type === 'file') type = 'file';
            
            fields.push({ selector, label: labelText, type, options });
        }
        return fields;
    }""")

# ── Field Filling ─────────────────────────────────────────────────────

def human_type(page: Page, selector: str, text: str):
    """Type with human-like delays."""
    page.click(selector, click_count=3)  # Select existing content
    for char in text:
        page.type(selector, char, delay=random.randint(30, 100))
    time.sleep(random.uniform(0.1, 0.4))

def upload_file(page: Page, selector: str, filepath: str):
    """Upload a file to a file input."""
    try:
        page.set_input_files(selector, filepath)
        return True
    except Exception:
        return False

def fill_field(page: Page, field: dict, job_context: dict) -> bool:
    """Fill a single form field."""
    label = field["label"]
    selector = field["selector"]
    ftype = field["type"]
    
    if ftype == "file":
        if re.search(r'resume|cv', label, re.IGNORECASE) or label == "":
            if RESUME_PATH and os.path.exists(RESUME_PATH):
                ok = upload_file(page, selector, RESUME_PATH)
                if ok:
                    print(f"  ✓ Uploaded resume: {RESUME_PATH}")
                    time.sleep(2)
                return ok
            return False
        if re.search(r'cover', label, re.IGNORECASE):
            return True  # Cover letter goes in textarea
        return False
    
    if ftype in ("text", "textarea"):
        value = match_known(label)
        if not value and re.search(r'cover letter', label, re.IGNORECASE):
            value = f"I am writing to express my interest in the {job_context.get('title', '')} role at {job_context.get('company', 'your company')}. As a Business Analyst and Founder of H Heuristics LLC, I bring analytical rigor and hands-on experience delivering actionable insights to clients. With 40+ client engagements, 84+ published market intelligence reports, and certifications including CFI BIDA and SAS Statistical Business Analyst, I am eager to contribute to your team.\n\nSincerely,\nHunter Hughes"
        if not value:
            return False
        
        human_type(page, selector, value)
        print(f"  ✓ Filled: {label[:40]} → {value[:50]}...")
        return True
    
    if ftype == "select":
        options = field.get("options", [])
        if not options:
            return False
        choice = match_option(label, options)
        if not choice:
            return False
        page.select_option(selector, label=choice)
        print(f"  ✓ Selected: {label[:40]} → {choice}")
        return True
    
    if ftype == "radio":
        # Find the radio in the group that matches our choice
        choice = match_option(label, [])
        page.click(selector)
        print(f"  ✓ Clicked: {label[:40]}")
        return True
    
    if ftype == "checkbox":
        if re.search(r'agree|consent|acknowledge|privacy|gdpr|terms', label, re.IGNORECASE):
            page.click(selector)
            print(f"  ✓ Checked: {label[:40]}")
            return True
        return False
    
    return False

# ── Main Apply Flow ───────────────────────────────────────────────────

def apply_to_job(page: Page, job_url: str, job_context: dict = None):
    """Navigate to job, fill form, pause for review."""
    if job_context is None:
        job_context = {}
    
    print(f"\n{'='*60}")
    print(f"Opening: {job_url}")
    print(f"{'='*60}")
    
    # Navigate to the application page
    page.goto(job_url, wait_until="networkidle", timeout=45000)
    time.sleep(2)
    
    # Check for CAPTCHA
    has_captcha = page.evaluate("""() => {
        return !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha, [data-sitekey]');
    }""")
    
    if has_captcha:
        print("\n⚠️  CAPTCHA detected — you'll need to solve it before the form appears.")
        input("Press Enter once you've solved the CAPTCHA...")
        time.sleep(2)
    
    # Inspect the form
    fields = inspect_form(page)
    
    if not fields:
        # Try clicking an Apply button
        clicked = page.evaluate("""() => {
            const btns = [...document.querySelectorAll('a[href], button, [role="button"]')];
            const btn = btns.find(el => {
                const t = (el.textContent || '').trim();
                return /^apply/i.test(t) || /apply for this job/i.test(t) || /apply now/i.test(t);
            });
            if (btn) { btn.click(); return true; }
            return false;
        }""")
        if clicked:
            time.sleep(3)
            fields = inspect_form(page)
    
    if not fields:
        print("❌ No form fields found on this page.")
        return False
    
    print(f"\nFound {len(fields)} form fields:")
    for f in fields:
        req = " *" if f.get("required") else ""
        print(f"  [{f['type']}]{req} {f['label'][:60]}")
    
    print(f"\n{'—'*40}")
    print("AUTO-FILLING FIELDS...")
    print(f"{'—'*40}")
    
    filled = 0
    skipped = 0
    for field in fields:
        try:
            if fill_field(page, field, job_context):
                filled += 1
            else:
                skipped += 1
                if field.get("required"):
                    print(f"  ⚠️  Could not fill REQUIRED field: {field['label'][:50]}")
            time.sleep(random.uniform(0.2, 0.7))
        except Exception as e:
            print(f"  ✗ Error on {field['label'][:40]}: {e}")
            skipped += 1
    
    print(f"\n{'—'*40}")
    print(f"Filled: {filled} | Skipped: {skipped}")
    print(f"{'—'*40}")
    print("\n🛑 REVIEW THE FORM ABOVE — then press Enter to continue to next job")
    print("   (The form is NOT submitted. You review and click Submit yourself.)")
    input()
    
    return True

# ── Job Discovery ─────────────────────────────────────────────────────

def find_analyst_jobs(max_jobs: int = 20):
    """Search API sources for analyst jobs with direct ATS links."""
    import urllib.request
    
    print("Searching for analyst jobs...")
    jobs = []
    seen = set()
    
    # Try Greenhouse boards for companies we know work
    companies = [
        "airbnb", "lyft", "instacart", "reddit", "chime",
        "samsara", "brex", "stripe", "doordash",
    ]
    
    search_terms = ["analyst", "research", "strategy", "operations", "data"]
    
    for slug in companies:
        try:
            url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true"
            req = urllib.request.Request(url, headers={"User-Agent": "auto-job-apps/1.0"})
            resp = urllib.request.urlopen(req, timeout=10)
            data = json.loads(resp.read())
            
            for j in data.get("jobs", []):
                title = (j.get("title") or "").lower()
                if not any(t in title for t in search_terms):
                    continue
                if any(t in title for t in ["senior", "sr.", "staff", "principal", "director", "vp", "lead", "engineer", "software", "counsel", "attorney", "legal"]):
                    continue
                
                company = j.get("company_name", slug.title())
                loc = j.get("location", {}).get("name", "Remote") if isinstance(j.get("location"), dict) else str(j.get("location", "Remote"))
                job_url = f"https://boards.greenhouse.io/{slug}/jobs/{j['id']}"
                
                key = f"{company}:{title}"
                if key in seen:
                    continue
                seen.add(key)
                
                jobs.append({
                    "title": j["title"],
                    "company": company,
                    "url": job_url,
                    "location": loc,
                    "ats": "greenhouse",
                })
        except Exception:
            continue
    
    print(f"Found {len(jobs)} analyst jobs")
    return jobs[:max_jobs]

# ── CLI ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Local auto-apply for job applications")
    parser.add_argument("--url", help="Apply to a specific job URL")
    parser.add_argument("--count", type=int, default=20, help="Number of jobs to find (default: 20)")
    parser.add_argument("--resume", help="Path to resume PDF")
    args = parser.parse_args()
    
    global RESUME_PATH
    if args.resume:
        RESUME_PATH = args.resume
    
    jobs = []
    if args.url:
        jobs = [{"url": args.url, "title": "Position", "company": "Company", "ats": "unknown"}]
    else:
        jobs = find_analyst_jobs(args.count)
    
    if not jobs:
        print("No jobs found. Try --url to specify a job URL directly.")
        return
    
    print(f"\nReady to process {len(jobs)} jobs.")
    print("A browser window will open for each job.")
    print("The form will be auto-filled. YOU review and click Submit.")
    print()
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, slow_mo=50)
        
        applied = 0
        for i, job in enumerate(jobs):
            if i > 0:
                print(f"\n{'='*60}")
                print(f"Job {i+1}/{len(jobs)} — press Enter to continue or 'q' to quit")
                choice = input().strip().lower()
                if choice == 'q':
                    break
            
            page = browser.new_page()
            page.set_viewport_size({"width": 1280, "height": 1600})
            
            try:
                success = apply_to_job(page, job["url"], {
                    "title": job.get("title", ""),
                    "company": job.get("company", ""),
                })
                if success:
                    applied += 1
            except Exception as e:
                print(f"Error: {e}")
            finally:
                page.close()
        
        browser.close()
        print(f"\n{'='*60}")
        print(f"Done! Reviewed {applied} applications.")
        print(f"{'='*60}")

if __name__ == "__main__":
    main()
