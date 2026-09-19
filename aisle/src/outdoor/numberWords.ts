/**
 * Numbers and street names as words (03 Task 3 / Task 4).
 *
 * ElevenLabs Flash v2.5 does no text normalization and Agent A's SpeechService
 * rejects a digit in `text` in dev, so nothing with a digit may reach the speech
 * layer. Distances are computed in metres and spoken in feet.
 *
 * Pure functions only.
 */

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

const ORDINALS: Record<string, string> = {
  '1': 'first', '2': 'second', '3': 'third', '4': 'fourth', '5': 'fifth',
  '6': 'sixth', '7': 'seventh', '8': 'eighth', '9': 'ninth', '10': 'tenth',
  '11': 'eleventh', '12': 'twelfth', '13': 'thirteenth', '14': 'fourteenth',
  '15': 'fifteenth', '16': 'sixteenth', '17': 'seventeenth', '18': 'eighteenth',
  '19': 'nineteenth', '20': 'twentieth', '30': 'thirtieth', '40': 'fortieth',
  '50': 'fiftieth', '60': 'sixtieth', '70': 'seventieth', '80': 'eightieth',
  '90': 'ninetieth',
};

export const FEET_PER_METRE = 3.280839895;

/** Non-negative integers below one hundred thousand, as words. */
export function integerToWords(n: number): string {
  if (!Number.isFinite(n)) return 'zero';
  const v = Math.max(0, Math.round(n));
  if (v < 20) return ONES[v]!;
  if (v < 100) {
    const t = TENS[Math.floor(v / 10)]!;
    const r = v % 10;
    return r === 0 ? t : `${t}-${ONES[r]}`;
  }
  if (v < 1000) {
    const h = `${ONES[Math.floor(v / 100)]} hundred`;
    const r = v % 100;
    return r === 0 ? h : `${h} ${integerToWords(r)}`;
  }
  if (v < 100000) {
    const th = `${integerToWords(Math.floor(v / 1000))} thousand`;
    const r = v % 1000;
    return r === 0 ? th : `${th} ${integerToWords(r)}`;
  }
  return 'a long way';
}

/** Ordinal words for the small numbers that appear in street names. */
export function ordinalToWords(digits: string): string {
  const direct = ORDINALS[digits];
  if (direct) return direct;
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return digits;
  if (n < 100) {
    const tens = Math.floor(n / 10) * 10;
    const ones = n % 10;
    if (ones === 0) return ORDINALS[String(tens)] ?? integerToWords(n);
    return `${TENS[Math.floor(n / 10)]}-${ORDINALS[String(ones)] ?? integerToWords(ones)}`;
  }
  return integerToWords(n);
}

/** Metres → feet, rounded to the nearest ten below one hundred, fifty above. */
export function roundFeet(metres: number): number {
  const feet = Math.max(0, metres) * FEET_PER_METRE;
  if (feet < 100) return Math.max(10, Math.round(feet / 10) * 10);
  return Math.round(feet / 50) * 50;
}

/** "sixty feet" / "about two hundred feet" (`about` above one hundred). */
export function feetWords(metres: number): string {
  const feet = roundFeet(metres);
  const words = `${integerToWords(feet)} feet`;
  return feet >= 100 ? `about ${words}` : words;
}

/** Just the number, as words: "sixty", "two hundred fifty". */
export function feetNumberWords(metres: number): string {
  return integerToWords(roundFeet(metres));
}

const ABBREVIATIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bN\b\.?/g, 'North'],
  [/\bS\b\.?/g, 'South'],
  [/\bE\b\.?/g, 'East'],
  [/\bW\b\.?/g, 'West'],
  [/\bNE\b\.?/g, 'Northeast'],
  [/\bNW\b\.?/g, 'Northwest'],
  [/\bSE\b\.?/g, 'Southeast'],
  [/\bSW\b\.?/g, 'Southwest'],
  [/\bSt\b\.?/g, 'Street'],
  [/\bAve\b\.?/g, 'Avenue'],
  [/\bAv\b\.?/g, 'Avenue'],
  [/\bBlvd\b\.?/g, 'Boulevard'],
  [/\bRd\b\.?/g, 'Road'],
  [/\bDr\b\.?/g, 'Drive'],
  [/\bPkwy\b\.?/g, 'Parkway'],
  [/\bPky\b\.?/g, 'Parkway'],
  [/\bLn\b\.?/g, 'Lane'],
  [/\bCt\b\.?/g, 'Court'],
  [/\bPl\b\.?/g, 'Place'],
  [/\bSq\b\.?/g, 'Square'],
  [/\bTer\b\.?/g, 'Terrace'],
  [/\bHwy\b\.?/g, 'Highway'],
  [/\bExt\b\.?/g, 'Extension'],
  [/\bFwy\b\.?/g, 'Freeway'],
  [/\bCir\b\.?/g, 'Circle'],
  [/\bMt\b\.?/g, 'Mount'],
  [/\bFt\b\.?/g, 'Fort'],
];

const LETTERS_ONLY = /^[A-Za-z]{1,3}$/;

/**
 * Street names in fully spoken form: abbreviations expanded, route numbers and
 * ordinals turned into words, nothing left that contains a digit.
 * "S Bouquet St" → "South Bouquet Street"; "US-19" → "U S nineteen".
 */
export function spokenStreet(raw: string): string {
  let s = (raw ?? '').trim();
  if (s === '') return '';
  // Abbreviations first, so "S" in "S Bouquet St" is South but "US-19" keeps its letters.
  for (const [re, full] of ABBREVIATIONS) s = s.replace(re, full);
  // Route designations: "US-19", "PA 8", "I-376".
  s = s.replace(/\b([A-Za-z]{1,3})[-\s]?(\d{1,4})\b/g, (whole, letters: string, digits: string) => {
    if (!LETTERS_ONLY.test(letters)) return whole;
    const spelled = letters.toUpperCase().split('').join(' ');
    return `${spelled} ${integerToWords(Number(digits))}`;
  });
  // Ordinals: "5th Avenue", "42nd Street".
  s = s.replace(/\b(\d{1,3})(?:st|nd|rd|th)\b/gi, (_m, digits: string) => ordinalToWords(digits));
  // Any digit left over (house numbers, "Route 51") spoken as a plain number.
  s = s.replace(/\d+/g, (m) => integerToWords(Number(m)));
  return s.replace(/\s+/g, ' ').trim();
}
