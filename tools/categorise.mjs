// Category classification from the P279* closure. Pure — no network, no DOM —
// so it is testable headlessly and re-runnable over an existing slice.
//
// DESIGN.md's editorial position is that we do not decide what counts as an
// event; we classify everything and make the categories a filter. That makes
// this file the place where that promise is kept or broken.
//
// How it works: an item's P31 types are expanded to their full superclass
// closure (fetched once by tools/fetch-closures.mjs), and the first rule whose
// root QID appears in that closure wins.
//
// RULES IS ORDERED AND THE ORDER IS LOAD-BEARING. It is a flat list rather
// than a map of category -> roots because the priority that matters is between
// individual roots, not between categories: a battle is also a historical
// period, an Olympic Games edition is also a recurring event, and a
// revolution is both a conflict and a political event. Specific roots come
// first; broad ones are last resorts.
//
// Roots were chosen by measuring which ancestors actually occur in the data
// (see docs/decisions.md) rather than by browsing the ontology. Wikidata's
// upper ontology is not usable for this: the most common ancestors across a
// real slice are "entity", "abstract object", "mathematical object" and
// "topological space". Broad roots also collide across senses — Q3505845
// "state" reaches 104 items of the 525-item slice, almost none of them
// political.

// [root QID, category, comment]. The comment is the label at the time of
// writing; labels drift, QIDs do not, so the QID is the contract.
export const RULES = [
  // --- conflict ---------------------------------------------------------
  // Before politics: a war is a political event too, and before period: a war
  // is also an "aspect of history".
  ["Q350604", "conflict", "armed conflict"],
  ["Q198", "conflict", "war"],
  ["Q178561", "conflict", "battle"],
  ["Q645883", "conflict", "military operation"],
  ["Q15835236", "conflict", "military action"],
  ["Q10931", "conflict", "revolution"],
  ["Q180684", "conflict", "conflict — broad, kept last of this group"],

  // --- disaster ---------------------------------------------------------
  // Before geology: an impact event or mass extinction is also a geological
  // event, and the disaster reading is the one a reader means.
  ["Q3839081", "disaster", "disaster"],
  ["Q8065", "disaster", "natural disaster"],
  ["Q7944", "disaster", "earthquake"],
  ["Q3241045", "disaster", "disease outbreak"],
  ["Q44512", "disaster", "epidemic"],

  // --- geology ----------------------------------------------------------
  // The geological column: periods, epochs, eons. These are the deep-time
  // backbone of the timeline, so they get a category of their own rather than
  // being folded into "period", which means human history.
  ["Q4005761", "geology", "geochronological unit"],
  ["Q4005689", "geology", "chronostratigraphic unit"],
  ["Q3694119", "geology", "stratigraphic unit"],
  ["Q2669627", "geology", "eonothem"],
  ["Q108256", "geology", "eon"],
  ["Q109975697", "geology", "geological event"],

  // --- life -------------------------------------------------------------
  // Taxa are kept and tagged rather than excluded — see docs/decisions.md.
  // "First appearance of this clade" is a real event at a real time, which is
  // exactly what makes deep time populated at all.
  ["Q16521", "life", "taxon"],
  ["Q23038290", "life", "fossil taxon"],
  ["Q713623", "life", "clade"],
  ["Q7239", "life", "organism"],
  ["Q55983715", "life", "organisms known by a particular common name"],

  // --- sport ------------------------------------------------------------
  // Before culture ("recurring event", "edition") and before politics (the
  // Olympics reach polity-flavoured ancestors through host countries).
  ["Q13406554", "sport", "sports competition"],
  ["Q16510064", "sport", "sporting event"],
  ["Q18608583", "sport", "recurring sporting event"],
  ["Q114609228", "sport", "recurring sporting event edition"],
  ["Q27020041", "sport", "sports season"],

  // --- science ----------------------------------------------------------
  // Thin, and honestly so. A top-N-by-sitelinks slice contains almost no
  // discoveries or experiments — the notable-science items that do have dates
  // rank below wars and taxa on sitelink count. This is a property of the
  // ranking, not of the classifier; expect it to fill in at harvest scale.
  ["Q12579633", "science", "invention"],
  ["Q6999", "science", "astronomical object"],
  ["Q2465832", "science", "branch of science"],

  // --- culture ----------------------------------------------------------
  ["Q17537576", "culture", "creative work"],
  ["Q838948", "culture", "work of art"],
  ["Q7725310", "culture", "series of creative works"],
  ["Q732577", "culture", "publication"],
  ["Q968159", "culture", "art movement"],
  ["Q1792644", "culture", "art style"],
  ["Q32880", "culture", "architectural style"],
  ["Q34770", "culture", "language"],
  ["Q25295", "culture", "language family"],
  ["Q8192", "culture", "writing system"],
  ["Q5891", "culture", "philosophy"],
  ["Q11042", "culture", "culture"],

  // --- politics ---------------------------------------------------------
  // Polities and the machinery of states. Deliberately after conflict and
  // sport, deliberately before period: "historical country" is both a polity
  // and a historical period, and the polity reading carries more information.
  ["Q3024240", "politics", "historical country"],
  ["Q1063239", "politics", "polity"],
  ["Q16562419", "politics", "political entity"],
  ["Q7210356", "politics", "political organization"],
  ["Q18810687", "politics", "political institution"],
  ["Q30111082", "politics", "political event"],
  ["Q131569", "politics", "treaty"],
  ["Q164950", "politics", "dynasty"],
  ["Q40231", "politics", "public election"],
  ["Q7188", "politics", "government"],
  ["Q51645", "politics", "ecumenical council"],

  // --- period -----------------------------------------------------------
  // Human-history periods, and the archaeology that names them. Last, because
  // almost everything historical reaches "aspect of history" eventually.
  ["Q11514315", "period", "historical period"],
  ["Q6428674", "period", "era"],
  ["Q465299", "period", "archaeological culture"],
  ["Q8432", "period", "civilization"],
  ["Q1620908", "period", "historical region"],
  ["Q13418847", "period", "historical event"],
  ["Q17524420", "period", "aspect of history — broadest rule in the file"],

];

// Rules that were tried and removed, so they are not re-derived. All four were
// attempts to drain the residual "other" bucket with broad roots, run last so
// they could only catch leftovers. Measured on the 525-item slice, each was a
// net loss:
//
//   Q2424752  product             -> Titanic, Oktoberfest, April Fools' Day,
//                                    hamburger. "Product" reaches 100 of 525.
//   Q123691918 tool               -> every currency in the slice (euro, yen,
//                                    dollar, ...) classified as science.
//   Q42240    research            -> Hellenistic period, via "middle chronology".
//   Q336      science             -> Hellenistic period again, and pinyin. Both
//                                    of its two matches were wrong.
//   Q11862829 academic discipline -> early modern period, modern period, via
//                                    "academic major".
//
// The target of all four was the daily-life technology sitting in "other" —
// oven, torch, sickle, beer. They were never reachable: those items carry no
// P31 statement at all, so they have no closure to match. A rule cannot fix
// missing data. If that cluster matters, it needs a different signal than P31.

export const CATEGORIES = [
  "conflict",
  "disaster",
  "life",
  "geology",
  "politics",
  "science",
  "culture",
  "sport",
  "period",
  "other",
];

// Expand an item's P31 types to the union of their closures.
export function ancestorsOf(typeQids, closures) {
  const out = new Set();
  for (const q of typeQids ?? []) {
    for (const a of closures[q] ?? [q]) out.add(a);
  }
  return out;
}

// Returns { category, via } — via is the root QID that matched, kept so a
// surprising classification can be traced to the rule that caused it without
// re-deriving anything.
export function classify(typeQids, closures) {
  const ancestors = ancestorsOf(typeQids, closures);
  for (const [root, category] of RULES) {
    if (ancestors.has(root)) return { category, via: root };
  }
  return { category: "other", via: null };
}
