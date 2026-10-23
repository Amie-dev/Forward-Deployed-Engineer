/**
 * Chapter 05 — MCP does not choose Resources. Your APPLICATION does.
 *
 * That is the whole chapter in one file: the protocol gives you a catalogue,
 * and picking from it is ordinary application code. Four of the five strategies
 * from the notes are implemented here; the fifth (LLM routing) is left out
 * because it needs a model inside the selection path, which is exactly the
 * trade-off Chapter 05 warns about.
 */
export type CatalogueEntry = { uri: string; description: string };

export type ResourceChoice = { uri: string; strategy: string; reason: string };

/** Chapter 05 — strategy 5, the cheap version: keywords in the user's message. */
const KEYWORDS: Record<string, string[]> = {
  "task://guidelines": ["policy", "guideline", "rule", "priority", "prioriti", "schedule", "should i"],
  "task://backlog": ["task", "backlog", "to-do", "todo", "pending", "plate", "work"],
  "task://summary": ["how many", "how busy", "summary", "overview", "workload"],
};

/**
 * Strategy 1 — the user picked it. This always wins: an explicit choice beats
 * any guess the application could make.
 */
export function byUserChoice(uri: string): ResourceChoice {
  return { uri, strategy: "user selection", reason: "the user asked for this Resource explicitly" };
}

/**
 * Strategy 2 — application state. The application knows things the user did not
 * say: every planning request needs the rules, whoever asked and however.
 */
export function byAppState(message: string): ResourceChoice[] {
  if (!/plan|prioriti|schedule|busy|workload/i.test(message)) {
    return [];
  }

  return [
    {
      uri: "task://guidelines",
      strategy: "application state",
      reason: "a planning request always needs the rules, even when the user does not mention them",
    },
  ];
}

/**
 * Strategy 4 — retrieval. Score the catalogue against the message and take the
 * entries that match. Cheap, explainable, and good enough for a small server.
 */
export function byRetrieval(message: string, catalogue: CatalogueEntry[]): ResourceChoice[] {
  const text = message.toLowerCase();

  return catalogue
    .filter((entry) => (KEYWORDS[entry.uri] ?? []).some((keyword) => text.includes(keyword)))
    .map((entry) => ({
      uri: entry.uri,
      strategy: "retrieval",
      reason: `the message mentions "${entry.uri}" keywords`,
    }));
}

/**
 * The one function the host calls. Order matters: rules before retrieval, so a
 * required Resource is never dropped just because the wording did not match.
 * Duplicates collapse to the first (strongest) strategy that chose them.
 */
export function selectResources(message: string, catalogue: CatalogueEntry[]): ResourceChoice[] {
  const chosen = [...byAppState(message), ...byRetrieval(message, catalogue)];

  const unique = new Map<string, ResourceChoice>();
  for (const choice of chosen) {
    if (!unique.has(choice.uri)) {
      unique.set(choice.uri, choice);
    }
  }

  return [...unique.values()];
}
