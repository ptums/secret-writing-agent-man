// Reads which quoted phrases the user wants kept or dropped from their own wording:
//   I like "we listen", I like "let's bring real change". I don't like the rest.
//   Let's drop "to your practice and patients" and find a way to make the rest work
// Done in code because the router model got this backwards in testing (it kept the
// phrase the user disliked and changed the one they liked).

const KEEP = /\b(like|love|keep|keeping|want to keep|good|works?|happy with|stays?)\b/i;
const DROP = /\b(drop|remove|delete|cut|lose|get rid of|don'?t like|do not like|dislike|hate|not a fan|without)\b/i;
const QUOTE = /["“]([^"“”]{2,})["”]/g;

export function quotedPreferences(message: string) {
  const keep: string[] = [];
  const drop: string[] = [];
  let clauseStart = 0;
  let previous: "keep" | "drop" | null = null;
  for (const m of message.matchAll(QUOTE)) {
    // The words just before this quote, back to the previous quote or sentence break.
    const before = message.slice(clauseStart, m.index);
    const lead = before.split(/[.!?\n]|\bbut\b|\band\b(?=\s+i\b)/i).at(-1) ?? before;
    // `keep "a" and "b"`: a quote joined only by "and"/"or"/a comma shares the previous intent.
    const joined: boolean = previous !== null && /^\s*(,|and|or|plus|&|also)?\s*$/i.test(lead);
    const intent: "keep" | "drop" | null = joined
      ? previous
      : DROP.test(lead)
        ? "drop"
        : KEEP.test(lead)
          ? "keep"
          : null;
    if (intent === "drop") drop.push(m[1].trim());
    if (intent === "keep") keep.push(m[1].trim());
    previous = intent;
    clauseStart = m.index! + m[0].length;
  }
  return { keep, drop };
}
