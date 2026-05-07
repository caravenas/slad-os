/**
 * Utilities for extracting content from Markdown body sections.
 */

/**
 * Returns the content under a heading (exact match, case-sensitive), stripped of the heading line.
 * If multiple headings match, takes the first. Returns undefined if not found.
 */
export function extractSection(body: string, heading: string): string | undefined {
  const lines = body.split("\n");
  const headingLine = heading.trim();

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === headingLine) {
      startIdx = i + 1;
      break;
    }
  }

  if (startIdx === -1) return undefined;

  // Collect lines until the next heading of same or higher level, or EOF
  const headingLevel = (headingLine.match(/^(#+)/) ?? ["", ""])[1].length;
  const sectionLines: string[] = [];

  for (let i = startIdx; i < lines.length; i++) {
    const match = lines[i].match(/^(#+)\s/);
    if (match && match[1].length <= headingLevel) break;
    sectionLines.push(lines[i]);
  }

  return sectionLines.join("\n").trim();
}

/**
 * Parses bullet lines `- item` to an array of strings.
 * Strips the leading `- ` (one dash + one space). Preserves internal spaces.
 * Skips empty lines or lines not starting with `- `.
 */
export function parseBulletList(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^-\s/.test(line))
    .map((line) => line.replace(/^-\s+/, ""));
}

/**
 * Extracts a section and parses it as a bullet list.
 * Returns empty array if section is missing or has no bullets.
 */
export function extractBulletSection(body: string, heading: string): string[] {
  const section = extractSection(body, heading);
  if (!section) return [];
  return parseBulletList(section);
}
