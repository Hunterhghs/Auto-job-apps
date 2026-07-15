import profileData from "../profile/profile.json";

export type Profile = typeof profileData;

export const profile: Profile = profileData;

/**
 * Flat list of known question->answer mappings used by form adapters and as
 * grounding context for the AI answer engine.
 */
export function knownAnswers(p: Profile): Record<string, string> {
  return {
    "full name": p.name.full,
    "first name": p.name.first,
    "last name": p.name.last,
    "preferred first name": p.name.preferredFirst,
    "preferred last name": p.name.preferredLast,
    "preferred pronouns": p.name.pronouns,
    pronouns: p.name.pronouns,
    email: p.contact.email,
    phone: p.contact.phone,
    location: p.contact.location,
    "current location": p.contact.location,
    city: p.contact.city,
    country: p.contact.country,
    "linkedin profile": p.links.linkedin || p.links.upwork,
    "linkedin profile url": p.links.linkedin || p.links.upwork,
    website: p.links.website,
    portfolio: p.links.website,
    "salary expectations": p.compensation.salaryDefaultAnswer,
    "expected salary": p.compensation.salaryDefaultAnswer,
    "desired salary": p.compensation.salaryDefaultAnswer,
    "hourly rate": p.compensation.hourlyDefaultAnswer,
    "hourly salary expectations": p.compensation.hourlyDefaultAnswer,
    "notice period": p.preferences.noticePeriod,
    "when can you start": p.preferences.noticePeriod,
    "how did you hear about this job": p.preferences.howDidYouHear,
    "how did you hear about us": p.preferences.howDidYouHear,
  };
}
